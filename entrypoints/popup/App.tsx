import { useEffect, useState } from 'react';
import { useAppStore } from '@/store/useAppStore';
import {
  MessageType,
  GroupDetail,
  GroupInfo,
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
    updateItemPrice,
    updateGroupPrice,
    setError,
    reset,
    clearGroupDetails,
  } = useAppStore();

  const [activeTab, setActiveTab] = useState<boolean>(false);
  const [groupList, setGroupList] = useState<GroupInfo[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set());

  useEffect(() => {
    browser.tabs.query({ active: true, currentWindow: true }).then(async (tabs) => {
      const tab = tabs[0];
      if (tab?.url?.includes('buff.163.com')) {
        setActiveTab(true);
        if (tab.id) {
          try {
            const result = await browser.tabs.sendMessage(tab.id, {
              type: MessageType.GET_ALL_GROUPS,
            });
            if (result?.groups) {
              setGroupList(result.groups);
              setSelectedGroups(new Set(result.groups.map((g: GroupInfo) => g.assetId)));
            }
          } catch (e) {
            console.error('Failed to get groups:', e);
          } finally {
            setLoading(false);
          }
        }
      } else {
        setLoading(false);
      }
    });
  }, []);

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

  const handleStart = async () => {
    setError(null);
    setGroupDetails([]);
    reset();

    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;

    const selectedGroupInfos = groupList.filter(g => selectedGroups.has(g.assetId));

    if (selectedGroupInfos.length === 0) {
      setError('请至少选择一个商品组');
      return;
    }

    const groups = selectedGroupInfos.map(g => ({
      assetId: g.assetId,
      goodsId: g.goodsId,
      classId: '',
      instanceId: '',
      contextId: '',
      appId: '',
    }));

    setIsProcessing(true);
    await browser.tabs.sendMessage(tab.id, {
      type: MessageType.START_PROCESS,
      payload: { groups },
    });
  };

  const toggleGroup = (assetId: string) => {
    setSelectedGroups(prev => {
      const newSet = new Set(prev);
      if (newSet.has(assetId)) {
        newSet.delete(assetId);
      } else {
        newSet.add(assetId);
      }
      return newSet;
    });
  };

  const toggleAll = () => {
    if (selectedGroups.size === groupList.length) {
      setSelectedGroups(new Set());
    } else {
      setSelectedGroups(new Set(groupList.map(g => g.assetId)));
    }
  };

  const handleStop = async () => {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;

    await browser.tabs.sendMessage(tab.id, { type: MessageType.STOP_PROCESS });
    setIsProcessing(false);
  };

  const totalItems = groupDetails.reduce((sum, d) => sum + d.items.length, 0);
  const totalValue = groupDetails.reduce(
    (sum, d) => sum + d.items.reduce((s, i) => s + i.suggestedPrice, 0),
    0
  );

  const handleGoToBuff = () => {
    browser.tabs.create({ url: 'https://buff.163.com/market/steam_inventory' });
  };

  const getStatusText = (status: string) => {
    switch (status) {
      case 'selecting': return '正在选择商品组...';
      case 'parsing': return '正在解析商品信息...';
      case 'fetching_price': return '正在获取市场价格...';
      default: return '';
    }
  };

  const getProgressPercent = () => {
    if (!progress || progress.total === 0) return 0;
    return Math.round((progress.current / progress.total) * 100);
  };

  if (!activeTab) {
    return (
      <div className="app-container">
        <div className="header">
          <div className="logo">⚡</div>
          <h1>Buff 自动上架</h1>
        </div>
        <div className="warning-card">
          <div className="warning-icon">⚠️</div>
          <p>请在网易Buff页面使用此插件</p>
          <button onClick={handleGoToBuff} className="btn-primary">
            前往 Buff 页面
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="app-container">
      {error && (
        <div className="error-toast">
          <span>❌</span>
          {error}
        </div>
      )}

      {loading && (
        <div className="loading-card">
          <div className="spinner"></div>
          <span>正在加载商品列表...</span>
        </div>
      )}

      {isProcessing && progress && (
        <div className="progress-card">
          <div className="progress-header">
            <span className="progress-label">处理进度</span>
            <span className="progress-value">{progress.current} / {progress.total}</span>
          </div>
          <div className="progress-track">
            <div
              className="progress-fill"
              style={{ width: `${getProgressPercent()}%` }}
            />
          </div>
          <div className="progress-status">
            <span className="status-icon">🔄</span>
            {getStatusText(progress.status)}
          </div>
        </div>
      )}

      {!isProcessing && groupDetails.length === 0 && !loading && groupList.length > 0 && (
        <div className="groups-section">
          <div className="section-header">
            <h2>商品组列表</h2>
            <button onClick={toggleAll} className="btn-link">
              {selectedGroups.size === groupList.length ? '取消全选' : '全选'}
            </button>
          </div>
          <div className="section-info">
            已选 <strong>{selectedGroups.size}</strong> 组 · 共 <strong>{groupList.reduce((s, g) => s + g.count, 0)}</strong> 件
          </div>
          <div className="groups-list">
            {groupList.map((group) => (
              <div
                key={group.assetId}
                className={`group-card ${selectedGroups.has(group.assetId) ? 'selected' : ''}`}
                onClick={() => toggleGroup(group.assetId)}
              >
                <div className="checkbox">
                  {selectedGroups.has(group.assetId) && <span>✓</span>}
                </div>
                <img src={group.image} alt={group.name} className="group-image" />
                <div className="group-info">
                  <p className="group-name">{group.name}</p>
                  <p className="group-count">{group.count} 件</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {!isProcessing && groupDetails.length === 0 && !loading && groupList.length === 0 && (
        <div className="empty-card">
          <span className="empty-icon">📦</span>
          <p>未找到可出售的商品</p>
          <span className="empty-hint">请确认已在库存页面</span>
        </div>
      )}

      {groupDetails.length > 0 && (
        <div className="results-section">
          <div className="section-header">
            <button
              onClick={clearGroupDetails}
              className="btn-back"
            >
              ← 返回
            </button>
            <h2>商品列表</h2>
            <span className="section-badge">{groupDetails.length} 组 / {totalItems} 件</span>
          </div>

          <div className="items-list">
            {groupDetails.map((detail) => (
              <div key={detail.group.goodsId} className="item-group-card">
                <div className="item-group-header">
                  <span className="item-group-name">
                    {detail.items[0]?.name || `商品组 ${detail.group.goodsId}`}
                  </span>
                  <span className="market-price">
                    最低 ¥{detail.marketLowestPrice.toFixed(2)}
                  </span>
                </div>

                {detail.items.map((item) => (
                  <div key={item.assetId} className="item-row">
                    <div className="item-details">
                      <p className="item-name">{item.name}</p>
                      <p className="item-wear">磨损: {item.wear}</p>
                    </div>
                    <div className="item-pricing">
                      <div className="price-input-wrapper compact">
                        <span className="currency">¥</span>
                        <input
                          type="number"
                          step="0.01"
                          min="0.01"
                          value={item.suggestedPrice.toFixed(2)}
                          onChange={(e) => {
                            const newPrice = Math.max(0.01, parseFloat(e.target.value) || 0.01);
                            updateItemPrice(detail.group.goodsId, item.assetId, newPrice);
                          }}
                          onClick={(e) => e.stopPropagation()}
                          className="price-input"
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="footer">
        {!isProcessing ? (
          <div className="footer-row">
            <div className="total-value-inline">
              <span className="value-label-sm">总计</span>
              <span className="value-amount-sm">¥{totalValue.toFixed(2)}</span>
            </div>
            <div className="footer-buttons">
              <button onClick={handleStart} className="btn-secondary btn-compact">
                {groupDetails.length > 0 ? '重新计算' : '开始计算'}
              </button>
              {groupDetails.length > 0 && (
                <button className="btn-primary btn-compact">
                  开始上架
                </button>
              )}
            </div>
          </div>
        ) : (
          <button onClick={handleStop} className="btn-danger btn-large">
            ⏹ 停止
          </button>
        )}
      </div>
    </div>
  );
}
