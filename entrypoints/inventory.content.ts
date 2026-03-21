import {
  MessageType,
  InventoryGroup,
  InventoryItem,
  GroupDetail,
  ProcessProgress,
} from '@/utils/message';

export default defineContentScript({
  matches: ['*://buff.163.com/', '*://buff.163.com/?*'],
  main() {
    console.log('[Buff Auto List] Inventory content script loaded');

    // 处理状态
    let isProcessing = false;
    let shouldStop = false;

    // 确保库存页面的"合并相同项"是勾选状态
    ensureCombineChecked();

    // 监听来自 Popup/Background 的消息
    browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      console.log('[Inventory] Received message:', message);

      switch (message.type) {
        case MessageType.GET_SELECTED_GROUPS:
          // 再次确保合并选项已勾选
          ensureCombineChecked();
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
     */
    async function processGroup(
      group: InventoryGroup,
      progress: ProcessProgress
    ): Promise<GroupDetail | null> {
      console.log(`[Inventory] Processing group: ${group.goodsId}`);

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
      await sleep(300);

      // 点击选中商品组
      (groupElement as HTMLElement).click();
      await sleep(300);

      // 2. 点击上架按钮
      const shelveBtn = document.querySelector('#shelve.i_Btn');
      if (!shelveBtn) {
        throw new Error('找不到上架按钮');
      }
      (shelveBtn as HTMLElement).click();
      console.log('[Inventory] Clicked shelve button');

      // 3. 等待弹窗出现
      await waitForElement('.popup', 5000);
      await sleep(500);

      // 4. 取消合并相同项
      progress.status = 'parsing';
      sendProgress(progress);

      await uncheckCombine();
      await sleep(500);

      // 5. 解析商品列表
      const items = parseItemsList(group.goodsId);
      console.log(`[Inventory] Parsed ${items.length} items from group`);

      // 6. 关闭弹窗
      closePopup();
      await sleep(300);

      // 7. 获取市场价格（通过 background）
      progress.status = 'fetching_price';
      sendProgress(progress);

      const marketPrice = await fetchMarketPrice(group.goodsId);
      const suggestedPrice = Math.max(0.01, marketPrice - 0.01);

      // 设置建议价格
      items.forEach((item) => {
        item.suggestedPrice = suggestedPrice;
      });

      return {
        group,
        items,
        marketLowestPrice: marketPrice,
      };
    }

    // ==================== 辅助函数 ====================

    /**
     * 确保库存页面的"合并相同项"是勾选状态
     * span[value="on"] 没有 .on class 时需要点击勾选
     */
    function ensureCombineChecked(): void {
      const checkbox = document.querySelector('span[value="on"]');
      if (checkbox && !checkbox.classList.contains('on')) {
        (checkbox as HTMLElement).click();
        console.log('[Inventory] Checked inventory combine option');
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
