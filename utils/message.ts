// 消息类型枚举
export enum MessageType {
  // Popup -> Inventory Content Script
  GET_ALL_GROUPS = 'GET_ALL_GROUPS',
  GET_SELECTED_GROUPS = 'GET_SELECTED_GROUPS',
  START_PROCESS = 'START_PROCESS',
  STOP_PROCESS = 'STOP_PROCESS',
  CONFIRM_LIST = 'CONFIRM_LIST',

  // Inventory Content Script -> Popup
  ALL_GROUPS_RESULT = 'ALL_GROUPS_RESULT',
  SELECTED_GROUPS_RESULT = 'SELECTED_GROUPS_RESULT',
  GROUP_DETAIL = 'GROUP_DETAIL',
  PROCESS_PROGRESS = 'PROCESS_PROGRESS',
  PROCESS_COMPLETE = 'PROCESS_COMPLETE',
  PROCESS_ERROR = 'PROCESS_ERROR',

  // Inventory -> Background
  FETCH_MARKET_PRICE = 'FETCH_MARKET_PRICE',
  FETCH_WEAR_PRICES = 'FETCH_WEAR_PRICES', // 批量获取磨损区间价格

  // Background -> Goods Content Script
  GET_MARKET_PRICE = 'GET_MARKET_PRICE',

  // Goods -> Background
  MARKET_PRICE_RESULT = 'MARKET_PRICE_RESULT',
}

// 商品组简要信息（用于列表展示）
export interface GroupInfo {
  goodsId: string; // data-goods_id
  name: string; // 饰品名称
  image: string; // 图片 URL
  count: number; // 组内饰品件数
  assetId: string; // li 的 data-assetid（用于处理）
}

// 商品组（库存页面显示的合并项）
export interface InventoryGroup {
  assetId: string; // li 的 data-assetid
  goodsId: string; // a 的 data-goods_id
  classId: string;
  instanceId: string;
  contextId: string;
  appId: string;
}

// 单个商品（展开后的具体物品）
export interface InventoryItem {
  assetId: string; // tr 的 id 去掉 "asset_" 前缀
  goodsId: string; // tr 的 class 中的 goods_id_xxx
  name: string; // .textOne 的文本
  wear: string; // .paint-wear 的文本
  quickPrice: number; // data-quick-price
  price: number; // .f_Strong 的价格
  suggestedPrice: number; // 计算后的建议价格（最低价-0.01）
}

// 商品组详情
export interface GroupDetail {
  group: InventoryGroup;
  items: InventoryItem[];
  marketLowestPrice: number;
}

// 磨损区间
export interface WearRange {
  min: number;
  max: number;
}

// 磨损区间价格请求
export interface WearPriceRequest {
  goodsId: string;
  wearRange: WearRange;
}

// 磨损区间价格结果
export interface WearPriceResult {
  wearRange: WearRange;
  price: number;
}

// 处理进度
export interface ProcessProgress {
  total: number;
  current: number;
  currentGroup?: InventoryGroup;
  status: 'selecting' | 'parsing' | 'fetching_price' | 'complete';
}

// 消息接口
export interface Message<T = unknown> {
  type: MessageType;
  payload?: T;
  tabId?: number;
}

// 上架确认项
export interface ListItem {
  assetId: string;
  goodsId: string;
  name: string;
  wear: string;
  suggestedPrice: number;
}

// 发送消息到 Content Script
export async function sendToContentScript<T = unknown>(
  tabId: number,
  message: Message
): Promise<T> {
  return await browser.tabs.sendMessage(tabId, message);
}

// 发送消息到 Background
export async function sendToBackground<T = unknown>(
  message: Message
): Promise<T> {
  return await browser.runtime.sendMessage(message);
}

// 发送消息到 Popup
export async function sendToPopup<T = unknown>(message: Message): Promise<T> {
  return await browser.runtime.sendMessage(message);
}
