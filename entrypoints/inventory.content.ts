import {
  MessageType,
  InventoryGroup,
  InventoryItem,
  GroupDetail,
  GroupInfo,
  ProcessProgress,
  WearRange,
  WearPriceRequest,
  WearPriceResult,
} from '@/utils/message';

export default defineContentScript({
  matches: ['*://buff.163.com/', '*://buff.163.com/?*', '*://buff.163.com/market/steam_inventory*'],
  main() {
    console.log('[Buff Auto List] Inventory content script loaded');

    // 处理状态
    let isProcessing = false;
    let shouldStop = false;

    // 确保 URL 参数正确：state=cansell 和 fold=true
    ensureUrlParams();

    // 监听来自 Popup/Background 的消息
    browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      console.log('[Inventory] Received message:', message);

      switch (message.type) {
        case MessageType.GET_ALL_GROUPS:
          const allGroups = getAllGroups();
          sendResponse({ groups: allGroups });
          break;

        case MessageType.GET_SELECTED_GROUPS:
          const groups = getSelectedGroups();
          sendResponse({ groups });
          break;

        case MessageType.START_PROCESS:
          startProcess(message.payload?.groups || []);
          sendResponse({ success: true });
          break;

        case MessageType.STOP_PROCESS:
          stopProcess();
          sendResponse({ success: true });
          break;

        case MessageType.MARKET_PRICE_RESULT:
          // 接收从 background 返回的市场价格
          // 这个会在 processGroup 中处理
          break;
      }

      return true;
    });

    // ==================== 获取所有商品组 ====================

    /**
     * 获取页面上所有的商品组信息
     */
    function getAllGroups(): GroupInfo[] {
      const groups: GroupInfo[] = [];

      const items = document.querySelectorAll('li.my_inventory.card_folder');

      items.forEach((li) => {
        const anchor = li.querySelector('a[data-goods_id]');
        const img = li.querySelector('img');
        const nameLink = li.querySelector('h3 a');
        const countSpan = li.querySelector('.fold_asset_count');

        if (!anchor) return;

        const goodsId = anchor.getAttribute('data-goods_id') || '';
        const assetId = li.getAttribute('data-assetid') || '';
        const name = nameLink?.textContent?.trim() || '';
        const image = img?.src || '';
        const count = parseInt(countSpan?.getAttribute('data-fold_asset_count') || '0', 10);

        if (goodsId && assetId) {
          groups.push({
            goodsId,
            name,
            image,
            count,
            assetId,
          });
        }
      });

      console.log(`[Inventory] Found ${groups.length} groups total`);
      return groups;
    }

    // ==================== 获取选中的商品组 ====================

    /**
     * 获取用户选中的商品组
     * 用户点击 li 元素切换选中状态（.on class）
     */
    function getSelectedGroups(): InventoryGroup[] {
      const groups: InventoryGroup[] = [];

      // 选中的商品组有 .on class
      const selectedElements = document.querySelectorAll(
        'li.my_inventory.card_folder.on'
      );

      selectedElements.forEach((li) => {
        const anchor = li.querySelector('a[data-goods_id]');
        if (!anchor) return;

        const group: InventoryGroup = {
          assetId: li.getAttribute('data-assetid') || '',
          goodsId: anchor.getAttribute('data-goods_id') || '',
          classId: anchor.getAttribute('data-classid') || '',
          instanceId: anchor.getAttribute('data-instanceid') || '',
          contextId: anchor.getAttribute('data-contextid') || '',
          appId: anchor.getAttribute('data-appid') || '',
        };

        if (group.assetId && group.goodsId) {
          groups.push(group);
        }
      });

      console.log(`[Inventory] Found ${groups.length} selected groups`);
      return groups;
    }

    // ==================== 处理商品组 ====================

    /**
     * 开始处理选中的商品组
     */
    async function startProcess(groups: InventoryGroup[]) {
      if (isProcessing) {
        console.log('[Inventory] Already processing');
        return;
      }

      isProcessing = true;
      shouldStop = false;

      const progress: ProcessProgress = {
        total: groups.length,
        current: 0,
        status: 'selecting',
      };

      console.log(`[Inventory] Starting process for ${groups.length} groups`);

      for (let i = 0; i < groups.length; i++) {
        if (shouldStop) {
          console.log('[Inventory] Process stopped by user');
          break;
        }

        const group = groups[i];
        progress.current = i + 1;
        progress.currentGroup = group;

        try {
          // 处理单个商品组
          const detail = await processGroup(group, progress);
          if (detail) {
            // 发送商品组详情到 popup
            browser.runtime.sendMessage({
              type: MessageType.GROUP_DETAIL,
              payload: detail,
            });
          }
        } catch (error) {
          console.error(`[Inventory] Failed to process group ${group.goodsId}:`, error);
          browser.runtime.sendMessage({
            type: MessageType.PROCESS_ERROR,
            payload: {
              group,
              error: error instanceof Error ? error.message : String(error),
            },
          });
        }

        // 组间延迟，确保页面状态稳定
        if (!shouldStop && i < groups.length - 1) {
          await sleep(1000);
        }
      }

      // 完成
      isProcessing = false;
      progress.status = 'complete';
      browser.runtime.sendMessage({
        type: MessageType.PROCESS_COMPLETE,
        payload: progress,
      });

      console.log('[Inventory] Process completed');
    }

    /**
     * 处理单个商品组
     */
    async function processGroup(
      group: InventoryGroup,
      progress: ProcessProgress
    ): Promise<GroupDetail | null> {
      console.log(`[Inventory] Processing group: ${group.goodsId}`);

      // 确保之前的弹窗已关闭
      closePopup();
      await sleep(200);

      // 1. 取消之前所有已选中的商品组
      const previouslySelected = document.querySelectorAll('li.my_inventory.card_folder.on');
      previouslySelected.forEach((el) => {
        (el as HTMLElement).click();
      });
      await sleep(300);

      // 2. 点击商品组（选中状态）
      progress.status = 'selecting';
      sendProgress(progress);

      const groupElement = document.querySelector(
        `li.my_inventory[data-assetid="${group.assetId}"]`
      );
      if (!groupElement) {
        throw new Error(`找不到商品组元素: ${group.assetId}`);
      }

      // 滚动到元素可见位置
      groupElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(400);

      // 点击选中商品组
      (groupElement as HTMLElement).click();
      await sleep(500);

      // 3. 点击上架按钮
      const shelveBtn = document.querySelector('#shelve.i_Btn');
      if (!shelveBtn) {
        throw new Error('找不到上架按钮');
      }
      (shelveBtn as HTMLElement).click();
      console.log('[Inventory] Clicked shelve button');

      // 4. 等待弹窗出现
      await waitForElement('.popup', 5000);
      await sleep(800); // 增加等待时间确保弹窗内容加载完成

      // 5. 取消合并相同项
      progress.status = 'parsing';
      sendProgress(progress);

      await uncheckCombine();
      await sleep(500);

      // 6. 解析商品列表
      const items = parseItemsList(group.goodsId);
      console.log(`[Inventory] Parsed ${items.length} items from group`);

      // 7. 关闭弹窗
      closePopup();
      await waitForPopupClose(); // 等待弹窗完全关闭

      // 8. 获取市场价格（通过 background）
      progress.status = 'fetching_price';
      sendProgress(progress);

      // 计算每个商品的磨损区间
      const wearRanges = new Map<string, WearRange>();
      items.forEach((item) => {
        const wearValue = parseFloat(item.wear);
        if (!isNaN(wearValue) && wearValue > 0) {
          const range = calculateWearRange(wearValue);
          const key = `${range.min}-${range.max}`;
          if (!wearRanges.has(key)) {
            wearRanges.set(key, range);
          }
        }
      });

      console.log(`[Inventory] Calculated ${wearRanges.size} wear ranges`);

      // 批量获取磨损区间的价格
      const wearPriceRequests: WearPriceRequest[] = Array.from(wearRanges.values()).map((range) => ({
        goodsId: group.goodsId,
        wearRange: range,
      }));

      const wearPrices = await fetchWearPrices(wearPriceRequests);
      console.log(`[Inventory] Got ${wearPrices.length} wear prices`);

      // 打印磨损区间和对应的价格
      console.log('[Inventory] ========== 磨损区间价格 ==========');
      wearPrices.forEach((wp) => {
        console.log(`[Inventory] 区间 [${wp.wearRange.min}, ${wp.wearRange.max}] => 市场最低价: ¥${wp.price.toFixed(2)} => 建议价: ¥${Math.max(0.01, wp.price - 0.01).toFixed(2)}`);
      });
      console.log('[Inventory] ==============================');

      // 构建磨损区间到价格的映射
      const priceMap = new Map<string, number>();
      let defaultPrice = 0.01;
      wearPrices.forEach((wp) => {
        const key = `${wp.wearRange.min}-${wp.wearRange.max}`;
        priceMap.set(key, Math.max(0.01, wp.price - 0.01));
        // 取第一个非零价格作为默认价格
        if (wp.price > 0 && defaultPrice === 0.01) {
          defaultPrice = Math.max(0.01, wp.price - 0.01);
        }
      });

      // 设置建议价格
      console.log('[Inventory] ========== 商品价格分配 ==========');
      items.forEach((item) => {
        const wearValue = parseFloat(item.wear);
        if (!isNaN(wearValue) && wearValue > 0) {
          const range = calculateWearRange(wearValue);
          const key = `${range.min}-${range.max}`;
          item.suggestedPrice = priceMap.get(key) || defaultPrice;
          console.log(`[Inventory] ${item.name} | 磨损: ${item.wear} | 区间: [${range.min}, ${range.max}] => 建议价: ¥${item.suggestedPrice.toFixed(2)}`);
        } else {
          item.suggestedPrice = defaultPrice;
          console.log(`[Inventory] ${item.name} | 磨损无效，使用默认价: ¥${defaultPrice.toFixed(2)}`);
        }
      });
      console.log('[Inventory] ===============================');

      // 计算市场最低价（取所有区间最低价的最小值）
      const marketLowestPrice = Math.min(...wearPrices.map(wp => wp.price).filter(p => p > 0)) || 0;

      return {
        group,
        items,
        marketLowestPrice,
      };
    }

    /**
     * 计算磨损区间
     * 规则：按第一位非0数字后紧挨着的数字确定区间（不管是不是0）
     * 0-2: 区间 [x.0, x.2]
     * 3-5: 区间 [x.2, x.5]
     * 6-9: 区间 [x.5, x.10]
     *
     * 例如：
     * 0.0712 -> 第一位非0是7，后面是1 -> min=0.07, max=0.072
     * 0.0733 -> 第一位非0是7，后面是3 -> min=0.072, max=0.075
     * 0.0781 -> 第一位非0是7，后面是8 -> min=0.075, max=0.08
     * 0.0800 -> 第一位非0是8，后面是0 -> min=0.08, max=0.082
     * 0.0021 -> 第一位非0是2(万分位)，后面是1 -> min=0.002, max=0.0022
     * 0.0023 -> 第一位非0是2，后面是3 -> min=0.0022, max=0.0025
     * 0.0027 -> 第一位非0是2，后面是7 -> min=0.0025, max=0.003
     */
    function calculateWearRange(wear: number): WearRange {
      if (wear <= 0) {
        return { min: 0, max: 1 };
      }

      // 找到第一位非0数字的位置
      const wearStr = wear.toFixed(10); // 保留足够精度
      const match = wearStr.match(/^0\.(0*)([1-9])(\d)/);
      if (!match) {
        return { min: 0, max: 1 };
      }

      const zeros = match[1]; // 第一位非0前面有多少个0
      const firstNonZero = parseInt(match[2]); // 第一位非0数字
      const nextDigit = parseInt(match[3] || '0'); // 第一位非0后面紧挨着的数字（可以是0）

      // 计算第一位非0数字所在的小数位精度
      const firstPos = zeros.length + 1; // 第一位非0在第几位小数
      const firstPrecision = Math.pow(10, -firstPos);

      // 基础值（第一位非0数字所在的整区间）
      const baseValue = firstNonZero * firstPrecision;

      // 计算下级精度
      const secondPrecision = firstPrecision / 10;

      // 根据第一位非0后面的数字确定区间
      let min: number, max: number;

      if (nextDigit <= 2) {
        // 0-2: [x.0, x.2]
        min = baseValue;
        max = baseValue + 2 * secondPrecision;
      } else if (nextDigit <= 5) {
        // 3-5: [x.2, x.5]
        min = baseValue + 2 * secondPrecision;
        max = baseValue + 5 * secondPrecision;
      } else {
        // 6-9: [x.5, x.10]
        min = baseValue + 5 * secondPrecision;
        max = baseValue + 10 * secondPrecision;
      }

      // 四舍五入到正确精度
      const roundTo = (num: number, precision: number) => {
        const factor = 1 / precision;
        return Math.round(num * factor) / factor;
      };

      return {
        min: roundTo(min, secondPrecision),
        max: roundTo(max, secondPrecision),
      };
    }

    // ==================== 辅助函数 ====================

    /**
     * 确保 URL 参数正确：state=cansell 和 fold=true
     * Buff 使用 hash 参数（#后面的部分）
     */
    function ensureUrlParams(): void {
      console.log('[Inventory] Checking URL params...');
      console.log('[Inventory] Current href:', window.location.href);

      const hash = window.location.hash;
      const params = new URLSearchParams(hash.substring(1)); // 去掉 # 号

      console.log('[Inventory] state param:', params.get('state'));
      console.log('[Inventory] fold param:', params.get('fold'));

      let needRedirect = false;

      // 如果 search 部分有参数，需要移除
      if (window.location.search) {
        needRedirect = true;
        console.log('[Inventory] Need to remove search params');
      }

      if (params.get('state') !== 'cansell') {
        params.set('state', 'cansell');
        needRedirect = true;
        console.log('[Inventory] Need to set state=cansell');
      }

      if (params.get('fold') !== 'true') {
        params.set('fold', 'true');
        needRedirect = true;
        console.log('[Inventory] Need to set fold=true');
      }

      if (needRedirect) {
        const newHash = '#' + params.toString();
        const newUrl = window.location.pathname + newHash;
        console.log('[Inventory] Redirecting to:', newUrl);
        window.location.href = newUrl;
      } else {
        console.log('[Inventory] URL params already correct');
      }
    }

    /**
     * 取消弹窗里的合并相同项
     * span[value="combine"] 有 .on class 时需要点击取消
     */
    async function uncheckCombine(): Promise<void> {
      const checkbox = document.querySelector('span[value="combine"].on');
      if (checkbox) {
        (checkbox as HTMLElement).click();
        console.log('[Inventory] Unchecked popup combine option');
        await sleep(300);
      }
    }

    /**
     * 解析商品列表
     */
    function parseItemsList(goodsId: string): InventoryItem[] {
      const items: InventoryItem[] = [];
      const rows = document.querySelectorAll('tr.assets-item');

      rows.forEach((tr) => {
        const assetId = tr.id.replace('asset_', '');
        const nameEl = tr.querySelector('.textOne');
        const wearEl = tr.querySelector('.paint-wear');
        const priceEl = tr.querySelector('.f_Strong');

        const item: InventoryItem = {
          assetId,
          goodsId,
          name: nameEl?.textContent?.trim() || '',
          wear: wearEl?.textContent?.replace('磨损: ', '').trim() || '',
          quickPrice: parseFloat(tr.getAttribute('data-quick-price') || '0'),
          price: parsePrice(priceEl?.textContent || '0'),
          suggestedPrice: 0,
        };

        if (item.assetId && item.name) {
          items.push(item);
        }
      });

      return items;
    }

    /**
     * 关闭弹窗
     */
    function closePopup(): void {
      const closeBtn = document.querySelector('.popup-close');
      if (closeBtn) {
        (closeBtn as HTMLElement).click();
        console.log('[Inventory] Closed popup');
      }
    }

    /**
     * 等待弹窗完全关闭
     */
    async function waitForPopupClose(timeout = 3000): Promise<void> {
      const startTime = Date.now();

      while (Date.now() - startTime < timeout) {
        const popup = document.querySelector('.popup');
        if (!popup || !popup.isConnected) {
          console.log('[Inventory] Popup closed');
          return;
        }
        await sleep(100);
      }

      console.warn('[Inventory] Popup close timeout, forcing close');
      // 强制关闭
      closePopup();
      await sleep(200);
    }

    /**
     * 获取市场价格（通过 background 发起请求）
     */
    async function fetchMarketPrice(goodsId: string): Promise<number> {
      try {
        // 通过 background 发起请求，避免跨域问题
        const response = await browser.runtime.sendMessage({
          type: MessageType.FETCH_MARKET_PRICE,
          payload: { goodsId },
        });

        if (response?.price !== undefined) {
          console.log(`[Inventory] Market price for ${goodsId}: ${response.price}`);
          return response.price;
        }

        console.warn(`[Inventory] No market price found for ${goodsId}`);
        return 0;
      } catch (error) {
        console.error(`[Inventory] Failed to fetch market price:`, error);
        return 0;
      }
    }

    /**
     * 批量获取磨损区间价格（通过 background 发起请求）
     */
    async function fetchWearPrices(requests: WearPriceRequest[]): Promise<WearPriceResult[]> {
      if (requests.length === 0) {
        return [];
      }

      try {
        const response = await browser.runtime.sendMessage({
          type: MessageType.FETCH_WEAR_PRICES,
          payload: { requests },
        });

        if (response?.results) {
          console.log(`[Inventory] Got ${response.results.length} wear prices`);
          return response.results;
        }

        console.warn('[Inventory] No wear prices returned');
        return [];
      } catch (error) {
        console.error('[Inventory] Failed to fetch wear prices:', error);
        return [];
      }
    }

    /**
     * 解析价格字符串
     */
    function parsePrice(priceText: string | null): number {
      if (!priceText) return 0;
      // 移除货币符号和其他非数字字符
      const cleaned = priceText.replace(/[^\d.]/g, '');
      const price = parseFloat(cleaned);
      return isNaN(price) ? 0 : Math.abs(price);
    }

    /**
     * 发送进度更新
     */
    function sendProgress(progress: ProcessProgress): void {
      browser.runtime.sendMessage({
        type: MessageType.PROCESS_PROGRESS,
        payload: progress,
      });
    }

    /**
     * 等待元素出现
     */
    function waitForElement(selector: string, timeout = 5000): Promise<Element> {
      return new Promise((resolve, reject) => {
        const el = document.querySelector(selector);
        if (el) {
          resolve(el);
          return;
        }

        const observer = new MutationObserver(() => {
          const el = document.querySelector(selector);
          if (el) {
            observer.disconnect();
            resolve(el);
          }
        });

        observer.observe(document.body, { childList: true, subtree: true });

        setTimeout(() => {
          observer.disconnect();
          reject(new Error(`等待元素超时: ${selector}`));
        }, timeout);
      });
    }

    /**
     * 睡眠函数
     */
    function sleep(ms: number): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /**
     * 停止处理
     */
    function stopProcess(): void {
      shouldStop = true;
      console.log('[Inventory] Stop requested');
    }
  },
});
