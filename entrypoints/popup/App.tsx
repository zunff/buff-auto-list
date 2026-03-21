import { useEffect, useState } from 'react';
import { useAppStore } from '@/store/useAppStore';
import {
  MessageType,
  GroupDetail,
  ProcessProgress,
} from '@/utils/message';
import './App.css';

export default function App() {
  const {
    isProcessing,
    progress,
    groupDetails,
    error,
    setIsProcessing,
    setProgress,
    addGroupDetail,
    setGroupDetails,
    setError,
    reset,
  } = useAppStore();

  const [activeTab, setActiveTab] = useState<boolean>(false);

  // 检查当前标签页是否是 Buff 页面
  useEffect(() => {
    browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
      const tab = tabs[0];
      if (tab?.url?.includes('buff.163.com')) {
        setActiveTab(true);
      }
    });
  }, []);

  // 监听消息
  useEffect(() => {
    const listener = (message: { type: MessageType; payload?: unknown }) => {
      switch (message.type) {
        case MessageType.GROUP_DETAIL:
          addGroupDetail(message.payload as GroupDetail);
          break;
        case MessageType.PROCESS_PROGRESS:
          setProgress(message.payload as ProcessProgress);
          break;
        case MessageType.PROCESS_COMPLETE:
          setIsProcessing(false);
          setProgress(message.payload as ProcessProgress);
          break;
        case MessageType.PROCESS_ERROR:
          const errorPayload = message.payload as { error?: string };
          if (errorPayload?.error) {
            setError(errorPayload.error);
          }
          break;
      }
    };

    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
  }, []);

  // 开始处理
  const handleStart = async () => {
    setError(null);
    setGroupDetails([]);
    reset();

    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;

    // 获取选中的商品组
    const result = await browser.tabs.sendMessage(tab.id, {
      type: MessageType.GET_SELECTED_GROUPS,
    });

    if (result?.groups?.length > 0) {
      setIsProcessing(true);
      await browser.tabs.sendMessage(tab.id, {
        type: MessageType.START_PROCESS,
        payload: { groups: result.groups },
      });
    } else {
      setError('请先在页面上选择商品组（点击商品切换选中状态）');
    }
  };

  // 停止处理
  const handleStop = async () => {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;

    await browser.tabs.sendMessage(tab.id, { type: MessageType.STOP_PROCESS });
    setIsProcessing(false);
  };

  // 计算总商品数和总价值
  const totalItems = groupDetails.reduce((sum, d) => sum + d.items.length, 0);
  const totalValue = groupDetails.reduce(
    (sum, d) => sum + d.items.reduce((s, i) => s + i.suggestedPrice, 0),
    0
  );

  if (!activeTab) {
    return (
      <div className="popup-container">
        <div className="warning-box">
          请在网易Buff页面使用此插件
        </div>
      </div>
    );
  }

  return (
    <div className="popup-container">
      <h1 className="title">Buff 自动上架</h1>

      {/* 错误提示 */}
      {error && (
        <div className="error-box">
          {error}
        </div>
      )}

      {/* 使用说明 */}
      {!isProcessing && groupDetails.length === 0 && (
        <div className="info-box">
          <p className="text-sm font-medium mb-2">使用步骤：</p>
          <ol className="text-sm list-decimal list-inside space-y-1">
            <li>在页面上点击商品组选中（高亮）</li>
            <li>点击下方"开始计算价格"按钮</li>
            <li>查看商品信息和价格</li>
            <li>确认后执行上架</li>
          </ol>
        </div>
      )}

      {/* 进度显示 */}
      {isProcessing && progress && (
        <div className="progress-box">
          <div className="flex justify-between text-sm mb-1">
            <span>
              {progress.current} / {progress.total}
            </span>
            <span>
              {progress.total > 0
                ? Math.round((progress.current / progress.total) * 100)
                : 0}
              %
            </span>
          </div>
          <div className="progress-bar">
            <div
              className="progress-fill"
              style={{
                width: `${
                  progress.total > 0
                    ? (progress.current / progress.total) * 100
                    : 0
                }%`,
              }}
            />
          </div>
          <p className="text-xs text-gray-500 mt-2">
            {progress.status === 'selecting' && '正在选择商品组...'}
            {progress.status === 'parsing' && '正在解析商品信息...'}
            {progress.status === 'fetching_price' && '正在获取市场价格...'}
          </p>
        </div>
      )}

      {/* 商品列表 */}
      {groupDetails.length > 0 && (
        <div className="items-box">
          <div className="flex justify-between items-center mb-2">
            <h2 className="font-medium text-gray-700">商品列表</h2>
            <span className="text-sm text-gray-500">
              {groupDetails.length} 组 / {totalItems} 件
            </span>
          </div>

          {/* 统计信息 */}
          <div className="stats-box">
            <div>
              <span className="text-gray-500">预计总价值：</span>
              <span className="font-bold text-green-600">
                ¥ {totalValue.toFixed(2)}
              </span>
            </div>
          </div>

          {/* 商品详情列表 */}
          <div className="items-list">
            {groupDetails.map((detail) => (
              <div key={detail.group.goodsId} className="item-group">
                <div className="item-group-header">
                  <span className="font-medium text-sm">
                    {detail.items[0]?.name || `商品组 ${detail.group.goodsId}`}
                  </span>
                  <span className="text-xs text-gray-500">
                    市场最低: ¥{detail.marketLowestPrice.toFixed(2)}
                  </span>
                </div>
                {detail.items.map((item) => (
                  <div key={item.assetId} className="item-row">
                    <div className="flex-1">
                      <p className="text-sm truncate">{item.name}</p>
                      <p className="text-xs text-gray-500">磨损: {item.wear}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-bold text-green-600">
                        ¥{item.suggestedPrice.toFixed(2)}
                      </p>
                      <p className="text-xs text-gray-500">
                        原: ¥{item.price.toFixed(2)}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 控制按钮 */}
      <div className="button-row">
        {!isProcessing ? (
          <button onClick={handleStart} className="btn-primary flex-1">
            {groupDetails.length > 0 ? '重新计算' : '开始计算价格'}
          </button>
        ) : (
          <button onClick={handleStop} className="btn-danger flex-1">
            停止
          </button>
        )}
      </div>
    </div>
  );
}
