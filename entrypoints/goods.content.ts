import { MessageType } from '@/utils/message';

export default defineContentScript({
  matches: ['*://buff.163.com/goods/*'],
  main() {
    console.log('[Goods] Content script loaded');
    console.log('[Goods] URL:', window.location.href);
    console.log('[Goods] Document ready state:', document.readyState);

    // 监听来自 background 的消息
    browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      console.log('[Goods] Received message:', message);
      console.log('[Goods] Message type:', message.type);

      if (message.type === MessageType.GET_MARKET_PRICE) {
        console.log('[Goods] GET_MARKET_PRICE received, getting price...');
        const price = getMarketPrice();
        console.log('[Goods] Returning price:', price);
        sendResponse({ price });
        return true;
      }

      return true;
    });

    console.log('[Goods] Message listener registered');

    /**
     * 获取市场最低价
     */
    function getMarketPrice(): number {
      console.log('[Goods] Looking for market price...');
      console.log('[Goods] Page URL:', window.location.href);

      // 方法1: 从 hide-cny 元素获取（最准确）
      const hideCnyEl = document.querySelector('.hide-cny .c_Gray');
      console.log('[Goods] .hide-cny .c_Gray:', hideCnyEl?.textContent);
      if (hideCnyEl?.textContent) {
        const price = parsePrice(hideCnyEl.textContent);
        console.log('[Goods] Price from hide-cny:', price);
        if (price > 0) return price;
      }

      // 方法2: 从 f_Strong 元素获取
      const fStrongEl = document.querySelector('#market-selling-list tr.selling .f_Strong');
      console.log('[Goods] #market-selling-list tr.selling .f_Strong:', fStrongEl?.textContent);
      if (fStrongEl?.textContent) {
        const price = parsePrice(fStrongEl.textContent);
        console.log('[Goods] Price from f_Strong:', price);
        if (price > 0) return price;
      }

      // 方法3: 直接找第一个 selling 行的价格
      const firstRow = document.querySelector('#market-selling-list tr.selling');
      if (firstRow) {
        const strongEl = firstRow.querySelector('.f_Strong');
        console.log('[Goods] First row .f_Strong:', strongEl?.textContent);
        if (strongEl?.textContent) {
          const price = parsePrice(strongEl.textContent);
          console.log('[Goods] Price from first row:', price);
          if (price > 0) return price;
        }
      }

      // 调试: 打印所有可能的价格元素
      console.log('[Goods] All .f_Strong elements:');
      document.querySelectorAll('.f_Strong').forEach((el, i) => {
        console.log(`  [${i}]: "${el.textContent?.trim()}"`);
      });

      console.log('[Goods] All .hide-cny elements:');
      document.querySelectorAll('.hide-cny').forEach((el, i) => {
        console.log(`  [${i}]: "${el.textContent?.trim()}"`);
      });

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
