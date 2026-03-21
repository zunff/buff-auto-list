import { MessageType } from '@/utils/message';

export default defineBackground(() => {
  console.log('[Background] Script loaded');

  // 监听消息
  browser.runtime.onMessage.addListener((message: { type: string; payload?: Record<string, unknown>; goodsId?: string }, _sender, sendResponse) => {
    console.log('[Background] Received message:', message);

    switch (message.type) {
      case MessageType.FETCH_MARKET_PRICE:
        // 异步获取市场价格
        fetchMarketPriceViaTab(message.payload?.goodsId as string).then((price) => {
          sendResponse({ price });
        }).catch((error) => {
          console.error('[Background] Failed to fetch market price:', error);
          sendResponse({ price: 0 });
        });
        return true; // 保持消息通道开放

      case MessageType.MARKET_PRICE_RESULT:
        // 从 goods content script 收到价格结果
        // 这个在 fetchMarketPriceViaTab 中通过 tab 关闭来处理
        break;
    }

    return true;
  });

  /**
   * 通过打开标签页获取市场价格
   */
  async function fetchMarketPriceViaTab(goodsId: string): Promise<number> {
    const url = `https://buff.163.com/goods/${goodsId}`;

    // 打开新标签页（后台打开）
    const tab = await browser.tabs.create({ url, active: false });

    if (!tab.id) {
      throw new Error('Failed to create tab');
    }

    console.log(`[Background] Opened tab ${tab.id} for goods ${goodsId}`);

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        cleanup();
        resolve(0);
      }, 10000); // 10秒超时

      // 监听标签页更新
      const onUpdated = async (tabId: number, changeInfo: { status?: string }, _tab: unknown) => {
        if (tabId !== tab.id) return;

        if (changeInfo.status === 'complete') {
          // 页面加载完成，发送消息获取价格
          try {
            const response = await browser.tabs.sendMessage(tabId, {
              type: MessageType.GET_MARKET_PRICE,
            });

            cleanup();
            resolve(response?.price || 0);
          } catch (error) {
            console.error('[Background] Failed to get market price:', error);
            cleanup();
            resolve(0);
          }
        }
      };

      // 清理函数
      const cleanup = () => {
        clearTimeout(timeout);
        browser.tabs.onUpdated.removeListener(onUpdated);
        // 关闭标签页
        if (tab.id) {
          browser.tabs.remove(tab.id).catch(() => {});
        }
      };

      browser.tabs.onUpdated.addListener(onUpdated);
    });
  }
});
