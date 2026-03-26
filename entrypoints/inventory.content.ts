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

        case MessageType.START_LISTING:
          startListing(message.payload?.groupDetails || []);
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

      console.log('[Inventory] getAllGroups called');
      console.log('[Inventory] Current URL:', window.location.href);
      console.log('[Inventory] Document ready state:', document.readyState);

      const items = document.querySelectorAll('li.my_inventory.salable');
      console.log(`[Inventory] Found ${items.length} li.my_inventory.salable elements`);

      // 如果没找到，尝试其他选择器
      if (items.length === 0) {
        console.log('[Inventory] Trying alternative selectors...');
        const altItems = document.querySelectorAll('li.my_inventory');
        console.log(`[Inventory] Found ${altItems.length} li.my_inventory elements`);

        const cardFolders = document.querySelectorAll('.card_folder');
        console.log(`[Inventory] Found ${cardFolders.length} .card_folder elements`);

        // 打印页面结构帮助调试
        const allLi = document.querySelectorAll('li');
        console.log(`[Inventory] Total li elements on page: ${allLi.length}`);
      }

      items.forEach((li, index) => {
        const anchor = li.querySelector('a[data-goods_id]');
        const img = li.querySelector('img');
        const nameLink = li.querySelector('h3 a');
        const countSpan = li.querySelector('.fold_asset_count');

        console.log(`[Inventory] Item ${index}: anchor=${!!anchor}, img=${!!img}, nameLink=${!!nameLink}`);

        if (!anchor) return;

        const goodsId = anchor.getAttribute('data-goods_id') || '';
        const assetId = li.getAttribute('data-assetid') || '';
        const name = nameLink?.textContent?.trim() || '';
        const image = img?.src || '';
        const count = parseInt(countSpan?.getAttribute('data-fold_asset_count') || '0', 10);

        console.log(`[Inventory] Item ${index}: goodsId=${goodsId}, assetId=${assetId}, name=${name}`);

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
        'li.my_inventory.salable.on'
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

      // 确保之前的弹窗已关闭，并取消所有已选中的商品组
      await ensurePopupClosed();

      // 1. 点击商品组（选中状态）
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

      // 确保商品组处于未选中状态，然后再点击选中
      if (groupElement.classList.contains('on')) {
        console.log('[Inventory] Group already selected, deselecting first');
        (groupElement as HTMLElement).click();
        await sleep(300);
      }

      // 点击选中商品组
      (groupElement as HTMLElement).click();
      await sleep(500);

      // 验证选中状态
      if (!groupElement.classList.contains('on')) {
        console.warn('[Inventory] Group not selected, clicking again');
        (groupElement as HTMLElement).click();
        await sleep(300);
      }

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
     * 使用轮询确保成功
     */
    async function uncheckCombine(timeout = 10000): Promise<void> {
      console.log('[Inventory] Waiting to uncheck combine option...');
      const startTime = Date.now();

      // 先等待合并选项出现
      while (Date.now() - startTime < timeout) {
        // 检查弹窗内的合并选项（无论是否选中）
        const combineSpan = document.querySelector('span[value="combine"]');
        if (combineSpan) {
          // 找到了合并选项，检查是否选中
          const checkbox = document.querySelector('span[value="combine"].on');
          if (checkbox) {
            // 已选中，需要点击取消
            (checkbox as HTMLElement).click();
            console.log('[Inventory] Clicked combine checkbox to uncheck');
            await sleep(500);

            // 检查是否成功取消
            const stillOn = document.querySelector('span[value="combine"].on');
            if (!stillOn) {
              console.log('[Inventory] Successfully unchecked combine option');
              return;
            }
            // 如果还选中，继续尝试
          } else {
            // 合并选项存在但未选中
            console.log('[Inventory] Combine option already unchecked');
            return;
          }
        } else {
          // 合并选项还没出现，继续等待
          console.log('[Inventory] Waiting for combine option to appear...');
        }
        await sleep(200);
      }

      // 超时但不是致命错误，只是警告
      console.warn('[Inventory] Timeout waiting for combine option, continuing anyway');
    }

    /**
     * 解析商品列表
     * 验证解析的物品数量与弹窗标题显示的数量是否一致
     */
    function parseItemsList(goodsId: string): InventoryItem[] {
      const items: InventoryItem[] = [];
      const rows = document.querySelectorAll('tr.assets-item');

      // 获取弹窗标题中显示的物品数量
      const countSpan = document.querySelector('.popup .count em');
      const expectedCount = countSpan ? parseInt(countSpan.textContent || '0', 10) : 0;
      console.log(`[Inventory] Expected item count from popup: ${expectedCount}`);

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

      // 验证物品数量
      if (expectedCount > 0 && items.length !== expectedCount) {
        console.warn(`[Inventory] Item count mismatch! Expected: ${expectedCount}, Got: ${items.length}`);
      }

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
     * 确保弹窗完全关闭
     * 包括清理弹窗内容和遮罩层
     */
    async function ensurePopupClosed(): Promise<void> {
      // 先检查当前选中状态
      const currentSelected = document.querySelectorAll('li.my_inventory.on');
      console.log(`[Inventory] Currently selected groups: ${currentSelected.length}`);

      // 取消所有已选中的商品组（包括 card_folder 和 salable 类型）
      const selectors = ['li.my_inventory.card_folder.on', 'li.my_inventory.salable.on', 'li.my_inventory.on'];
      let deselected = 0;

      for (const selector of selectors) {
        const selected = document.querySelectorAll(selector);
        selected.forEach((el) => {
          (el as HTMLElement).click();
          deselected++;
        });
      }

      if (deselected > 0) {
        console.log(`[Inventory] Deselected ${deselected} groups`);
        await sleep(300);
      }

      // 关闭弹窗
      const popup = document.querySelector('.popup');
      if (popup && popup.isConnected) {
        closePopup();
        await sleep(300);
      }

      // 再次检查并强制清理弹窗 DOM
      const stillOpen = document.querySelector('.popup');
      if (stillOpen && stillOpen.isConnected) {
        console.warn('[Inventory] Force removing popup DOM');
        stillOpen.remove();
        // 移除遮罩层
        const mask = document.querySelector('.w-popui-bg');
        if (mask) mask.remove();
        await sleep(200);
      }

      // 再次确认没有选中的商品组
      const remainingSelected = document.querySelectorAll('li.my_inventory.on');
      if (remainingSelected.length > 0) {
        console.log(`[Inventory] Found ${remainingSelected.length} still selected, deselecting...`);
        remainingSelected.forEach((el) => {
          (el as HTMLElement).click();
        });
        await sleep(200);
      }

      // 最终验证
      const finalCheck = document.querySelectorAll('li.my_inventory.on');
      if (finalCheck.length > 0) {
        console.warn(`[Inventory] Warning: ${finalCheck.length} groups still selected after cleanup`);
      }
    }

    /**
     * 等待弹窗完全关闭
     */
    async function waitForPopupClose(timeout = 5000): Promise<void> {
      const startTime = Date.now();
      let forceCloseAttempts = 0;

      while (Date.now() - startTime < timeout) {
        const popup = document.querySelector('.popup');
        if (!popup || !popup.isConnected) {
          console.log('[Inventory] Popup closed');
          return;
        }

        // 如果弹窗还在，尝试关闭
        if (Date.now() - startTime > 1000 && forceCloseAttempts < 3) {
          closePopup();
          forceCloseAttempts++;
          console.log(`[Inventory] Force closing popup (attempt ${forceCloseAttempts})`);
        }

        await sleep(100);
      }

      // 最终尝试：移除弹窗 DOM
      const popup = document.querySelector('.popup');
      if (popup && popup.isConnected) {
        console.warn('[Inventory] Popup close timeout, removing DOM');
        popup.remove();
        // 移除遮罩层
        const mask = document.querySelector('.w-popui-bg');
        if (mask) mask.remove();
      }
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

    // ==================== 上架逻辑 ====================

    /**
     * 开始上架流程
     */
    async function startListing(groupDetails: GroupDetail[]) {
      if (isProcessing) {
        console.log('[Inventory] Already processing');
        return;
      }

      isProcessing = true;
      shouldStop = false;

      console.log(`[Inventory] Starting listing for ${groupDetails.length} groups`);

      // 按商品组处理
      for (let i = 0; i < groupDetails.length; i++) {
        if (shouldStop) {
          console.log('[Inventory] Listing stopped by user');
          break;
        }

        const detail = groupDetails[i];

        // 发送进度
        const progress: ProcessProgress = {
          total: groupDetails.length,
          current: i + 1,
          status: 'selecting',
        };
        browser.runtime.sendMessage({
          type: MessageType.LISTING_PROGRESS,
          payload: progress,
        });

        try {
          await listGroup(detail);
        } catch (error) {
          console.error(`[Inventory] Failed to list group ${detail.group.goodsId}:`, error);
        }

        // 组间延迟
        if (!shouldStop && i < groupDetails.length - 1) {
          await sleep(1000);
        }
      }

      // 完成
      isProcessing = false;
      browser.runtime.sendMessage({
        type: MessageType.LISTING_COMPLETE,
        payload: { total: groupDetails.length, current: groupDetails.length },
      });

      console.log('[Inventory] Listing completed');
    }

    /**
     * 上架单个商品组
     */
    async function listGroup(detail: GroupDetail) {
      console.log(`[Inventory] Listing group: ${detail.group.goodsId}`);

      // 确保之前的弹窗已关闭
      await ensurePopupClosed();

      // 2. 点击选中商品组
      const groupElement = document.querySelector(
        `li.my_inventory[data-assetid="${detail.group.assetId}"]`
      );
      if (!groupElement) {
        throw new Error(`找不到商品组元素: ${detail.group.assetId}`);
      }

      groupElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(400);
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
      await sleep(1000); // 增加等待时间确保弹窗内容加载完成

      // 5. 取消合并相同项
      await uncheckCombine();
      await sleep(500);

      // 6. 填写价格
      await fillPrices(detail.items);
      await sleep(300);

      // 7. 点击上架按钮
      const confirmBtn = document.querySelector('a.i_Btn.i_Btn_main.confirm') as HTMLElement;
      if (confirmBtn) {
        confirmBtn.click();
        console.log('[Inventory] Clicked confirm button');

        // 8. 等待上架成功弹窗
        await waitForSuccessToast();
        console.log('[Inventory] Success toast appeared');
      } else {
        console.warn('[Inventory] Confirm button not found');
      }

      console.log(`[Inventory] Listed ${detail.items.length} items for group ${detail.group.goodsId}`);
    }

    /**
     * 等待上架成功弹窗出现
     */
    async function waitForSuccessToast(timeout = 30000): Promise<void> {
      console.log('[Inventory] Waiting for success toast...');
      const startTime = Date.now();

      while (Date.now() - startTime < timeout) {
        const toast = document.querySelector('#j_w-Toast.w-Toast_success') as HTMLElement;
        if (toast && toast.style.display !== 'none') {
          console.log('[Inventory] Success toast found');
          await sleep(500); // 等待弹窗消失
          return;
        }
        await sleep(100);
      }

      throw new Error('等待上架成功弹窗超时');
    }

    /**
     * 填写价格
     */
    async function fillPrices(items: InventoryItem[]) {
      console.log(`[Inventory] Filling prices for ${items.length} items`);

      // 遍历弹窗中的商品行
      const rows = document.querySelectorAll('tr.assets-item');
      console.log(`[Inventory] Found ${rows.length} rows in popup`);

      rows.forEach((row) => {
        const tr = row as HTMLTableRowElement;
        const assetId = tr.id.replace('asset_', '');

        // 找到价格输入框
        const priceInput = tr.querySelector('input[name="price"]') as HTMLInputElement;
        if (!priceInput) {
          console.log(`[Inventory] No price input found for row ${assetId}`);
          return;
        }

        // 通过 assetId 找到对应的价格
        const item = items.find(i => i.assetId === assetId);
        if (item) {
          const price = item.suggestedPrice;
          priceInput.value = price.toFixed(2);

          // 触发 input 事件让页面识别
          priceInput.dispatchEvent(new Event('input', { bubbles: true }));
          priceInput.dispatchEvent(new Event('change', { bubbles: true }));

          console.log(`[Inventory] Set price ¥${price.toFixed(2)} for asset ${assetId}`);
        } else {
          console.log(`[Inventory] No matching item found for asset ${assetId}`);
        }
      });
    }
  },
});
