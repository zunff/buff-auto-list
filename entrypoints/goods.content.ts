import { MessageType } from '@/utils/message';

export default defineContentScript({
  matches: ['*://buff.163.com/goods/*'],
  main() {
    console.log('[Goods] Content script loaded');

    // 监听来自 background 的消息
    browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      console.log('[Goods] Received message:', message);

      if (message.type === MessageType.GET_MARKET_PRICE) {
        const price = getMarketPrice();
        console.log('[Goods] Market price:', price);
        sendResponse({ price });
      }

      return true;
    });

    /**
     * 获取市场最低价
     */
    function getMarketPrice(): number {
      const firstPriceEl = document.querySelector(
        '#market-selling-list tr.selling .f_Strong'
      );

      if (firstPriceEl?.textContent) {
        return parsePrice(firstPriceEl.textContent);
      }

      return 0;
    }

    /**
     * 解析价格字符串
     */
    function parsePrice(priceText: string): number {
      const cleaned = priceText.replace(/[^\d.]/g, '');
      const price = parseFloat(cleaned);
      return isNaN(price) ? 0 : Math.abs(price);
    }
  },
});
