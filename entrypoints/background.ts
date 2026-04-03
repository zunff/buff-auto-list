import { MessageType, WearPriceRequest, WearPriceResult, WearRange } from '@/utils/message';

export default defineBackground(() => {
  console.log('[Background] Script loaded');

  // 监听消息
  browser.runtime.onMessage.addListener((message: { type: string; payload?: Record<string, unknown>; goodsId?: string }, _sender, sendResponse) => {
    console.log('[Background] Received message:', message);

    switch (message.type) {
      case MessageType.FETCH_MARKET_PRICE:
        // 异步获取市场价格
        console.log('[Background] Fetching market price for:', message.payload?.goodsId);
        fetchMarketPriceViaTab(message.payload?.goodsId as string, undefined).then((price) => {
          console.log('[Background] Returning price:', price);
          sendResponse({ price });
        }).catch((error) => {
          console.error('[Background] Failed to fetch market price:', error);
          sendResponse({ price: 0 });
        });
        return true; // 保持消息通道开放

      case MessageType.FETCH_WEAR_PRICES:
        // 批量获取磨损区间价格
        console.log('[Background] Fetching wear prices for:', message.payload?.requests);
        fetchWearPrices(message.payload?.requests as WearPriceRequest[]).then((results) => {
          console.log('[Background] Returning wear prices:', results);
          sendResponse({ results });
        }).catch((error) => {
          console.error('[Background] Failed to fetch wear prices:', error);
          sendResponse({ results: [] });
        });
        return true;

      case MessageType.MARKET_PRICE_RESULT:
        // 从 goods content script 收到价格结果
        console.log('[Background] Received MARKET_PRICE_RESULT:', message);
        break;
    }

    return true;
  });

  /**
   * 批量获取磨损区间价格
   * 使用单个标签页，逐个获取每个磨损区间的价格
   */
  async function fetchWearPrices(requests: WearPriceRequest[]): Promise<WearPriceResult[]> {
    if (!requests || requests.length === 0) {
      return [];
    }

    const goodsId = requests[0].goodsId;
    const results: WearPriceResult[] = [];

    // 创建一个标签页用于获取所有价格
    const url = `https://buff.163.com/goods/${goodsId}`;
    const tab = await browser.tabs.create({ url, active: false });

    if (!tab.id) {
      console.error('[Background] Failed to create tab');
      return requests.map(r => ({ wearRange: r.wearRange, price: 0 }));
    }

    console.log(`[Background] Created tab ${tab.id} for goods ${goodsId}`);

    try {
      // 等待页面加载
      await new Promise<void>((resolve) => {
        const onUpdated = (tabId: number, changeInfo: { status?: string }) => {
          if (tabId === tab.id && changeInfo.status === 'complete') {
            browser.tabs.onUpdated.removeListener(onUpdated);
            resolve();
          }
        };
        browser.tabs.onUpdated.addListener(onUpdated);

        // 超时处理
        setTimeout(() => {
          browser.tabs.onUpdated.removeListener(onUpdated);
          resolve();
        }, 15000);
      });

      // 等待页面稳定
      await new Promise(r => setTimeout(r, 500));

      // 尝试注入脚本
      try {
        await browser.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['/content-scripts/goods.js']
        });
      } catch (e) {
        console.log('[Background] Script already injected or injection failed:', e);
      }

      await new Promise(r => setTimeout(r, 300));

      // 逐个获取每个磨损区间的价格
      for (const request of requests) {
        try {
          const price = await fetchPriceForWearRange(tab.id, goodsId, request.wearRange);
          results.push({
            wearRange: request.wearRange,
            price,
          });
          console.log(`[Background] Price for wear ${request.wearRange.min}-${request.wearRange.max}: ${price}`);
        } catch (error) {
          console.error(`[Background] Failed to get price for wear range:`, error);
          results.push({
            wearRange: request.wearRange,
            price: 0,
          });
        }
      }
    } finally {
      // 关闭标签页
      if (tab.id) {
        browser.tabs.remove(tab.id).catch(() => {});
      }
    }

    return results;
  }

  /**
   * 获取特定磨损区间的价格（带重试）
   */
  async function fetchPriceForWearRange(tabId: number, goodsId: string, wearRange: WearRange, maxRetries = 3): Promise<number> {
    // 构建带磨损参数的 URL
    const url = `https://buff.163.com/goods/${goodsId}#min_paintwear=${wearRange.min}&max_paintwear=${wearRange.max}`;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      console.log(`[Background] Fetching price for wear ${wearRange.min}-${wearRange.max}, attempt ${attempt}/${maxRetries}`);

      // 导航到新 URL
      await browser.tabs.update(tabId, { url });

      // 等待页面加载
      await new Promise<void>((resolve) => {
        const onUpdated = (tabId_: number, changeInfo: { status?: string }) => {
          if (tabId_ === tabId && changeInfo.status === 'complete') {
            browser.tabs.onUpdated.removeListener(onUpdated);
            resolve();
          }
        };
        browser.tabs.onUpdated.addListener(onUpdated);

        // 超时处理
        setTimeout(() => {
          browser.tabs.onUpdated.removeListener(onUpdated);
          resolve();
        }, 10000);
      });

      // 等待页面更新和数据加载
      await new Promise(r => setTimeout(r, 800 + attempt * 200)); // 每次重试增加等待时间

      // 获取价格
      try {
        const response = await browser.tabs.sendMessage(tabId, {
          type: MessageType.GET_MARKET_PRICE,
        });

        if (response?.price && response.price > 0) {
          console.log(`[Background] Got price ${response.price} for wear ${wearRange.min}-${wearRange.max}`);
          return response.price;
        }
      } catch (error) {
        console.error('[Background] Failed to get price via message:', error);
      }

      // 尝试直接通过 scripting 获取
      try {
        const results = await browser.scripting.executeScript({
          target: { tabId: tabId },
          func: () => {
            // 尝试多种选择器
            const hideCnyEl = document.querySelector('.hide-cny .c_Gray');
            if (hideCnyEl?.textContent) {
              const cleaned = hideCnyEl.textContent.replace(/[^\d.]/g, '');
              const price = parseFloat(cleaned);
              if (price > 0) return price;
            }

            const fStrongEl = document.querySelector('#market-selling-list tr.selling .f_Strong');
            if (fStrongEl?.textContent) {
              const cleaned = fStrongEl.textContent.replace(/[^\d.]/g, '');
              const price = parseFloat(cleaned);
              if (price > 0) return price;
            }

            const firstRow = document.querySelector('#market-selling-list tr.selling');
            if (firstRow) {
              const strongEl = firstRow.querySelector('.f_Strong');
              if (strongEl?.textContent) {
                const cleaned = strongEl.textContent.replace(/[^\d.]/g, '');
                const price = parseFloat(cleaned);
                if (price > 0) return price;
              }
            }

            return 0;
          }
        });

        const price = results?.[0]?.result || 0;
        if (price > 0) {
          console.log(`[Background] Got price ${price} via scripting for wear ${wearRange.min}-${wearRange.max}`);
          return price;
        }
      } catch (e) {
        console.error('[Background] Scripting failed:', e);
      }

      console.log(`[Background] Attempt ${attempt} failed, ${attempt < maxRetries ? 'retrying...' : 'giving up'}`);
    }

    console.warn(`[Background] Failed to get price for wear ${wearRange.min}-${wearRange.max} after ${maxRetries} attempts`);
    return 0;
  }

  /**
   * 通过打开标签页获取市场价格
   */
  async function fetchMarketPriceViaTab(goodsId: string, wearRange?: WearRange): Promise<number> {
    let url = `https://buff.163.com/goods/${goodsId}`;
    if (wearRange) {
      url += `#min_paintwear=${wearRange.min}&max_paintwear=${wearRange.max}`;
    }

    console.log('[Background] Creating tab for URL:', url);

    // 打开新标签页（后台打开）
    const tab = await browser.tabs.create({ url, active: false });

    if (!tab.id) {
      console.error('[Background] Failed to create tab');
      throw new Error('Failed to create tab');
    }

    console.log(`[Background] Opened tab ${tab.id} for goods ${goodsId}`);

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.log('[Background] Timeout waiting for price');
        cleanup();
        resolve(0);
      }, 20000); // 20秒超时

      // 监听标签页更新
      const onUpdated = async (tabId: number, changeInfo: { status?: string }, _tab: unknown) => {
        if (tabId !== tab.id) return;

        console.log(`[Background] Tab ${tabId} update:`, changeInfo.status);

        if (changeInfo.status === 'complete') {
          console.log(`[Background] Tab ${tabId} loaded, injecting content script...`);

          // 等待页面稳定
          await new Promise(r => setTimeout(r, 500));

          try {
            // 尝试注入 content script
            await browser.scripting.executeScript({
              target: { tabId: tabId },
              files: ['/content-scripts/goods.js']
            });
            console.log(`[Background] Injected goods.js into tab ${tabId}`);
          } catch (injectError) {
            console.log('[Background] Script already injected or injection failed:', injectError);
          }

          // 再等待一下让脚本初始化
          await new Promise(r => setTimeout(r, 500));

          // 发送消息获取价格
          try {
            console.log(`[Background] Sending GET_MARKET_PRICE to tab ${tabId}`);
            const response = await browser.tabs.sendMessage(tabId, {
              type: MessageType.GET_MARKET_PRICE,
            });
            console.log(`[Background] Got response from goods page:`, response);

            cleanup();
            resolve(response?.price || 0);
          } catch (error) {
            console.error('[Background] Failed to get market price:', error);
            // 尝试直接从页面获取价格
            try {
              const results = await browser.scripting.executeScript({
                target: { tabId: tabId },
                func: () => {
                  const hideCnyEl = document.querySelector('.hide-cny .c_Gray');
                  if (hideCnyEl?.textContent) {
                    const cleaned = hideCnyEl.textContent.replace(/[^\d.]/g, '');
                    return parseFloat(cleaned) || 0;
                  }
                  return 0;
                }
              });
              const price = results?.[0]?.result || 0;
              console.log('[Background] Got price via scripting:', price);
              cleanup();
              resolve(price);
            } catch (scriptingError) {
              console.error('[Background] Scripting also failed:', scriptingError);
              cleanup();
              resolve(0);
            }
          }
        }
      };

      // 清理函数
      const cleanup = () => {
        clearTimeout(timeout);
        browser.tabs.onUpdated.removeListener(onUpdated);
        // 关闭标签页
        if (tab.id) {
          console.log(`[Background] Closing tab ${tab.id}`);
          browser.tabs.remove(tab.id).catch(() => {});
        }
      };

      browser.tabs.onUpdated.addListener(onUpdated);
    });
  }
});
