# 网易Buff自动上架工具

一个用于网易Buff库存页面自动计算价格和上架的浏览器扩展。

## 功能特性

- 多选商品组批量处理
- 自动获取市场价格
- 自动计算建议售价（市场最低价 - 0.01元）
- 显示商品详细信息（名称、磨损度、价格）
- 实时处理进度显示

## 安装

```bash
# 安装依赖
pnpm install

# 构建扩展
pnpm build

# 开发模式
pnpm dev
```

构建完成后，在 Chrome 浏览器中：
1. 打开 `chrome://extensions/`
2. 开启"开发者模式"
3. 点击"加载已解压的扩展程序"
4. 选择 `.output/chrome-mv3` 目录

## 使用方法

### 第一步：选择商品组

1. 登录 [网易Buff](https://buff.163.com)
2. 进入库存页面
3. 点击商品组切换选中状态（选中的商品组会高亮显示）
4. 可以多选多个商品组

### 第二步：开始计算

1. 点击浏览器扩展图标打开弹窗
2. 点击"开始计算价格"按钮
3. 等待处理完成

### 第三步：查看结果

弹窗会显示：
- 每个商品组的商品列表
- 商品名称、磨损度
- 市场最低价
- 建议售价（最低价 - 0.01元）
- 预计总价值

## 技术流程

### 完整工作流程

```
用户选择商品组 → 点击开始计算 → 循环处理每个商品组
                                      ↓
                              点击商品组选中
                                      ↓
                              点击上架按钮
                                      ↓
                              等待弹窗出现
                                      ↓
                              取消合并相同项
                                      ↓
                              解析商品列表
                                      ↓
                              关闭弹窗
                                      ↓
                              获取市场价格
                                      ↓
                              计算建议价格
                                      ↓
                              发送到Popup显示
```

### DOM 选择器

| 元素 | 选择器 | 说明 |
|------|--------|------|
| 商品组 | `li.my_inventory.card_folder` | 库存页面的商品组容器 |
| 选中的商品组 | `li.my_inventory.card_folder.on` | 用户选中的商品组 |
| 上架按钮 | `#shelve.i_Btn` | 页面上的上架按钮 |
| 合并选项 | `span[value="combine"].on` | 合并相同项复选框 |
| 商品列表行 | `tr.assets-item` | 弹窗中的商品行 |
| 商品名称 | `.textOne` | 商品名称元素 |
| 商品磨损 | `.paint-wear` | 磨损度元素 |
| 商品价格 | `.f_Strong` | 价格元素 |
| 关闭弹窗 | `.popup-close` | 弹窗关闭按钮 |

### 数据结构

```typescript
// 商品组（库存页面显示的合并项）
interface InventoryGroup {
  assetId: string;    // li 的 data-assetid
  goodsId: string;    // a 的 data-goods_id
  classId: string;    // Steam classid
  instanceId: string; // Steam instanceid
  contextId: string;  // Steam contextid
  appId: string;      // Steam appid (730 = CSGO)
}

// 单个商品
interface InventoryItem {
  assetId: string;        // 商品唯一ID
  goodsId: string;        // 商品类型ID
  name: string;           // 商品名称
  wear: string;           // 磨损度
  quickPrice: number;     // 快速定价
  price: number;          // 当前价格
  suggestedPrice: number; // 建议售价
}

// 商品组详情
interface GroupDetail {
  group: InventoryGroup;
  items: InventoryItem[];
  marketLowestPrice: number; // 市场最低价
}
```

### 消息通信

| 消息类型 | 方向 | 说明 |
|----------|------|------|
| `GET_SELECTED_GROUPS` | Popup → Inventory | 获取选中的商品组 |
| `START_PROCESS` | Popup → Inventory | 开始处理商品组 |
| `STOP_PROCESS` | Popup → Inventory | 停止处理 |
| `GROUP_DETAIL` | Inventory → Popup | 发送商品组详情 |
| `PROCESS_PROGRESS` | Inventory → Popup | 发送处理进度 |
| `PROCESS_COMPLETE` | Inventory → Popup | 处理完成 |
| `PROCESS_ERROR` | Inventory → Popup | 处理错误 |
| `FETCH_MARKET_PRICE` | Inventory → Background | 请求市场价格 |
| `GET_MARKET_PRICE` | Background → Goods | 获取市场价格 |
| `MARKET_PRICE_RESULT` | Goods → Background | 返回市场价格 |

### 市场价格获取

通过打开新标签页获取市场价格，方便后续扩展更多操作：

```
1. Inventory 发送 FETCH_MARKET_PRICE 给 Background
2. Background 打开新标签页 (buff.163.com/goods/{goodsId})
3. 等待页面加载完成
4. Background 发送 GET_MARKET_PRICE 给 Goods content script
5. Goods 解析市场最低价，返回给 Background
6. Background 关闭标签页，返回价格给 Inventory
```

流程图：
```
Inventory                    Background                      Goods
    |                            |                             |
    |-- FETCH_MARKET_PRICE ----->|                             |
    |                            |-- 打开标签页 -->              |
    |                            |                             | (页面加载)
    |                            |<------ 页面加载完成 ----------|
    |                            |-- GET_MARKET_PRICE --------->|
    |                            |<-- MARKET_PRICE_RESULT ------|
    |                            |-- 关闭标签页 -->              |
    |<-- { price } --------------|                             |
```

### 价格计算规则

```
建议售价 = 市场最低价 - 0.01元
```

确保建议售价不低于 0.01 元。

## 项目结构

```
buff-auto-list/
├── entrypoints/
│   ├── background.ts        # 后台脚本（打开标签页、协调通信）
│   ├── inventory.content.ts # 库存页内容脚本（核心逻辑）
│   ├── goods.content.ts     # 商品页内容脚本（解析市场价格）
│   └── popup/
│       ├── App.tsx          # 弹窗UI
│       ├── App.css          # 弹窗样式
│       ├── main.tsx         # 弹窗入口
│       └── index.html       # 弹窗HTML
├── store/
│   └── useAppStore.ts       # Zustand状态管理
├── utils/
│   └── message.ts           # 消息类型定义
├── public/                  # 静态资源
├── wxt.config.ts            # WXT配置
├── package.json
└── README.md
```

### Content Script 说明

| 文件 | 匹配URL | 功能 |
|------|---------|------|
| **inventory.content.ts** | `buff.163.com/` | 库存页面，处理商品组选择、解析商品列表 |
| **goods.content.ts** | `buff.163.com/goods/*` | 商品页面，解析市场最低价 |

## 技术栈

- [WXT](https://wxt.dev/) - Web Extension 开发框架
- [React 19](https://react.dev/) - UI框架
- [Zustand](https://zustand-demo.pmnd.rs/) - 状态管理
- [Tailwind CSS 4](https://tailwindcss.com/) - 样式框架
- [TypeScript](https://www.typescriptlang.org/) - 类型支持

## 注意事项

1. **选择器可能变化**：Buff页面结构可能会更新，导致选择器失效，需要根据实际情况调整。

2. **请求频率**：处理多个商品组时会发起多个请求，建议适当控制频率避免被限流。

3. **登录状态**：需要保持Buff登录状态才能正常获取市场价格。

4. **合并相同项说明**：
   - **库存页面** `span[value="on"]`：扩展会自动确保勾选状态，这样才能看到商品组
   - **弹窗里** `span[value="combine"]`：扩展会自动取消勾选，以展开该商品组的所有具体商品

## 开发

```bash
# 开发模式（热重载）
pnpm dev

# 类型检查
pnpm typecheck

# 构建生产版本
pnpm build

# 打包zip
pnpm zip
```

## License

MIT
