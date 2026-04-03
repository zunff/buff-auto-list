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
          console.log('[Inventory] START_PROCESS payload:', JSON.stringify(message.payload?.groups, null, 2));
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
     * 解析挂件信息
     */
    function parseCharms(li: HTMLElement): import('@/utils/message').Charm[] {
      const charms: import('@/utils/message').Charm[] = [];
      const charmElements = li.querySelectorAll('.icon_charm');

      charmElements.forEach((el) => {
        const name = el.getAttribute('data-title') || '';
        const imgEl = el.querySelector('img');
        const image = imgEl?.src || '';
        // 解析价格：data-sell-reference-price="¥ 1.19"
        const priceText = el.getAttribute('data-sell-reference-price') || '';
        const priceMatch = priceText.match(/[\d.]+/);
        const price = priceMatch ? parseFloat(priceMatch[0]) : 0;

        if (name && image) {
          charms.push({ name, image, price });
        }
      });

      return charms;
    }

    /**
     * 获取页面上所有的商品组信息（fold=false 时按商品名称分组）
     * 解析展开的商品列表，按名称分组返回
     */
    function getAllGroups(): GroupInfo[] {
      console.log('[Inventory] getAllGroups called');
      console.log('[Inventory] Current URL:', window.location.href);
      console.log('[Inventory] Document ready state:', document.readyState);

      // fold=false 时，每个商品独立显示为一个 li
      const items = document.querySelectorAll('li.my_inventory.salable');
      console.log(`[Inventory] Found ${items.length} li.my_inventory.salable elements`);

      // 按商品名称分组
      const nameGroups = new Map<string, InventoryItem[]>();

      items.forEach((li, index) => {
        const anchor = li.querySelector('a[data-goods_id]');
        const img = li.querySelector('img');
        const nameLink = li.querySelector('h3 a');
        const wearEl = li.querySelector('.wear-value');

        if (!anchor) {
          console.log(`[Inventory] Item ${index}: no anchor, skipping`);
          return;
        }

        const goodsId = anchor.getAttribute('data-goods_id') || '';
        const assetId = li.getAttribute('data-assetid') || li.id || '';
        const name = nameLink?.textContent?.trim() || '';
        const image = img?.src || '';
        // 磨损值：去掉 "磨损: " 前缀
        let wear = '';
        if (wearEl?.textContent) {
          wear = wearEl.textContent.replace('磨损: ', '').trim();
        }

        const isSpecial = isSpecialGoods(name);

        // 解析挂件信息
        const charms = parseCharms(li as HTMLElement);

        console.log(`[Inventory] Item ${index}: goodsId=${goodsId}, assetId=${assetId}, name=${name}, wear=${wear}, isSpecial=${isSpecial}, charms=${charms.length}`);

        if (goodsId && assetId && name) {
          const item: InventoryItem = {
            assetId,
            goodsId,
            name,
            wear,
            image,
            isSpecial,
            charms: charms.length > 0 ? charms : undefined,
            quickPrice: 0,
            price: 0,
            suggestedPrice: 0,
          };

          if (!nameGroups.has(name)) {
            nameGroups.set(name, []);
          }
          nameGroups.get(name)!.push(item);
        }
      });

      // 转换为 GroupInfo 数组
      const groups: GroupInfo[] = [];
      nameGroups.forEach((items, name) => {
        const firstItem = items[0];
        groups.push({
          goodsId: firstItem.goodsId,
          name,
          image: firstItem.image || '',
          count: items.length,
          assetId: firstItem.assetId, // 使用第一个商品的 assetId 作为组标识
          items,
          isSpecial: firstItem.isSpecial,
        });
      });

      console.log(`[Inventory] Found ${groups.length} groups, ${items.length} items total`);
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
     * 接收 GroupInfo[]（每个包含 items 数组）
     */
    async function startProcess(groups: GroupInfo[]) {
      if (isProcessing) {
        console.log('[Inventory] Already processing');
        return;
      }

      isProcessing = true;
      shouldStop = false;

      const progress: ProcessProgress = {
        total: groups.length,
        current: 0,
        status: 'fetching_price',
      };

      console.log(`[Inventory] Starting process for ${groups.length} groups`);

      for (let i = 0; i < groups.length; i++) {
        if (shouldStop) {
          console.log('[Inventory] Process stopped by user');
          break;
        }

        const group = groups[i];
        progress.current = i + 1;

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
              group: { assetId: group.assetId, goodsId: group.goodsId },
              error: error instanceof Error ? error.message : String(error),
            },
          });
        }

        // 组间延迟
        if (!shouldStop && i < groups.length - 1) {
          await sleep(500);
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
     * 直接使用 GroupInfo 中的 items 数据获取价格
     */
    async function processGroup(
      group: GroupInfo,
      progress: ProcessProgress
    ): Promise<GroupDetail | null> {
      console.log(`[Inventory] Processing group: ${group.name}, isSpecial: ${group.isSpecial}`);

      const items = group.items || [];
      if (items.length === 0) {
        console.warn(`[Inventory] No items in group ${group.name}`);
        return null;
      }

      progress.status = 'fetching_price';
      sendProgress(progress);

      let marketLowestPrice = 0;

      if (group.isSpecial) {
        // 特殊商品：直接获取最低价，所有商品使用相同价格
        console.log(`[Inventory] Special goods, fetching lowest price only`);
        marketLowestPrice = await fetchMarketPrice(group.goodsId);
        const suggestedPrice = Math.max(0.01, marketLowestPrice - 0.01);

        items.forEach((item) => {
          // 基础价格
          let basePrice = suggestedPrice;
          // 加上挂件价格的 70%
          if (item.charms && item.charms.length > 0) {
            const charmBonus = item.charms.reduce((sum, c) => sum + c.price * 0.7, 0);
            basePrice = Math.max(0.01, basePrice + charmBonus);
            console.log(`[Inventory] ${item.name} | 特殊商品 + 挂件加价 ¥${charmBonus.toFixed(2)} => 建议价: ¥${basePrice.toFixed(2)}`);
          } else {
            console.log(`[Inventory] ${item.name} | 特殊商品 => 建议价: ¥${basePrice.toFixed(2)}`);
          }
          item.suggestedPrice = Math.round(basePrice * 100) / 100;
        });
      } else {
        // 普通商品：按磨损区间获取价格
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
          if (wp.price > 0 && defaultPrice === 0.01) {
            defaultPrice = Math.max(0.01, wp.price - 0.01);
          }
        });

        // 设置建议价格
        console.log('[Inventory] ========== 商品价格分配 ==========');
        items.forEach((item) => {
          const wearValue = parseFloat(item.wear);
          // 基础价格
          let basePrice = defaultPrice;
          if (!isNaN(wearValue) && wearValue > 0) {
            const range = calculateWearRange(wearValue);
            const key = `${range.min}-${range.max}`;
            basePrice = priceMap.get(key) || defaultPrice;
          }

          // 加上挂件价格的 70%
          if (item.charms && item.charms.length > 0) {
            const charmBonus = item.charms.reduce((sum, c) => sum + c.price * 0.7, 0);
            basePrice = Math.max(0.01, basePrice + charmBonus);
            const charmNames = item.charms.map(c => c.name).join(', ');
            console.log(`[Inventory] ${item.name} | 磨损: ${item.wear} | 挂件: ${charmNames} +¥${charmBonus.toFixed(2)} => 建议价: ¥${basePrice.toFixed(2)}`);
          } else {
            console.log(`[Inventory] ${item.name} | 磨损: ${item.wear} => 建议价: ¥${basePrice.toFixed(2)}`);
          }
          item.suggestedPrice = Math.round(basePrice * 100) / 100;
        });
        console.log('[Inventory] ===============================');

        // 计算市场最低价
        marketLowestPrice = Math.min(...wearPrices.map(wp => wp.price).filter(p => p > 0)) || 0;
      }

      // 构建 InventoryGroup 用于返回
      const inventoryGroup: InventoryGroup = {
        assetId: group.assetId,
        goodsId: group.goodsId,
        classId: '',
        instanceId: '',
        contextId: '',
        appId: '',
      };

      return {
        group: inventoryGroup,
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
     * 判断是否为特殊商品（音乐盒、印花、封装的涂鸦）
     * 这些商品没有磨损值，价格获取逻辑不同
     */
    function isSpecialGoods(name: string): boolean {
      // 音乐盒 |、印花 |、封装的涂鸦 |（注意有空格和|）
      return /^(音乐盒 |印花 |封装的涂鸦 )/.test(name);
    }

    /**
     * 确保 URL 参数正确：state=cansell 和 fold=false
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

      if (params.get('fold') !== 'false') {
        params.set('fold', 'false');
        needRedirect = true;
        console.log('[Inventory] Need to set fold=false');
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
     * 新逻辑：自动选中所有同名商品，不需要取消合并相同项
     */
    async function listGroup(detail: GroupDetail) {
      console.log(`[Inventory] Listing group: ${detail.items[0]?.name}, ${detail.items.length} items`);

      // 1. 确保之前的弹窗已关闭，取消所有已选中商品
      await ensurePopupClosed();

      // 2. 自动选中所有同名商品
      // 滚动到第一个商品位置
      const firstItem = detail.items[0];
      const firstElement = document.querySelector(
        `li.my_inventory[data-assetid="${firstItem.assetId}"]`
      );
      if (firstElement) {
        firstElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await sleep(400);
      }

      // 选中所有同名商品
      for (const item of detail.items) {
        const itemElement = document.querySelector(
          `li.my_inventory[data-assetid="${item.assetId}"]`
        );
        if (itemElement && !itemElement.classList.contains('on')) {
          (itemElement as HTMLElement).click();
          await sleep(100); // 短暂延迟
        }
      }
      await sleep(300);

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

      // 5. 注意：fold=false 时，不需要取消"合并相同项"
      // 因为商品本身就是展开的

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

      console.log(`[Inventory] Listed ${detail.items.length} items`);
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
