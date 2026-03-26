import { useEffect, useState } from 'react';
import { useAppStore } from '@/store/useAppStore';
import {
  MessageType,
  GroupDetail,
  GroupInfo,
  ProcessProgress,
  InventoryItem,
} from '@/utils/message';
import './App.css';

// 价格输入组件
function PriceInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [displayValue, setDisplayValue] = useState(value.toFixed(2));

  useEffect(() => {
    setDisplayValue(value.toFixed(2));
  }, [value]);

  return (
    <div className="price-input-wrapper compact" onClick={(e) => e.stopPropagation()}>
      <span className="currency">¥</span>
      <input
        type="text"
        value={displayValue}
        onChange={(e) => {
          setDisplayValue(e.target.value);
        }}
        onBlur={() => {
          const num = parseFloat(displayValue);
          const finalValue = isNaN(num) || num < 0.01 ? 0.01 : Math.round(num * 100) / 100;
          setDisplayValue(finalValue.toFixed(2));
          onChange(finalValue);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            (e.target as HTMLInputElement).blur();
          }
        }}
        className="price-input"
      />
    </div>
  );
}

// 计算磨损区间
function calculateWearRange(wear: number): { min: number; max: number } {
  try {
    if (wear <= 0 || isNaN(wear)) return { min: 0, max: 1 };

    const wearStr = wear.toFixed(10);
    const match = wearStr.match(/^0\.(0*)([1-9])(\d)/);
    if (!match) return { min: 0, max: 1 };

    const zeros = match[1];
    const firstNonZero = parseInt(match[2]);
    const nextDigit = parseInt(match[3] || '0');

    const firstPos = zeros.length + 1;
    const firstPrecision = Math.pow(10, -firstPos);
    const baseValue = firstNonZero * firstPrecision;
    const secondPrecision = firstPrecision / 10;

    let min: number, max: number;
    if (nextDigit <= 2) {
      min = baseValue;
      max = baseValue + 2 * secondPrecision;
    } else if (nextDigit <= 5) {
      min = baseValue + 2 * secondPrecision;
      max = baseValue + 5 * secondPrecision;
    } else {
      min = baseValue + 5 * secondPrecision;
      max = baseValue + 10 * secondPrecision;
    }

    const roundTo = (num: number, precision: number) => {
      const factor = 1 / precision;
      return Math.round(num * factor) / factor;
    };

    return { min: roundTo(min, secondPrecision), max: roundTo(max, secondPrecision) };
  } catch (e) {
    console.error('[Popup] calculateWearRange error:', e);
    return { min: 0, max: 1 };
  }
}

// 按磨损区间分组商品
function groupByWearRange(items: InventoryItem[]): Map<string, InventoryItem[]> {
  console.log('[Popup] groupByWearRange called with', items?.length, 'items');
  const groups = new Map<string, InventoryItem[]>();

  if (!items || !Array.isArray(items)) {
    console.error('[Popup] groupByWearRange: invalid items', items);
    return groups;
  }

  items.forEach((item) => {
    try {
      const wear = parseFloat(item.wear);
      const range = calculateWearRange(wear);
      const key = `${range.min}-${range.max}`;
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)!.push(item);
    } catch (e) {
      console.error('[Popup] groupByWearRange item error:', e, item);
    }
  });

  console.log('[Popup] groupByWearRange result:', groups.size, 'groups');
  return groups;
}

export default function App() {
  console.log('[Popup] App rendering...');

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

  console.log('[Popup] groupDetails:', groupDetails?.length, groupDetails);

  const [activeTab, setActiveTab] = useState<boolean>(false);
  const [groupList, setGroupList] = useState<GroupInfo[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set());
  const [expandedRanges, setExpandedRanges] = useState<Set<string>>(new Set());

  useEffect(() => {
    console.log('[Popup] useEffect running, checking active tab...');
    browser.tabs.query({ active: true, currentWindow: true }).then(async (tabs) => {
      const tab = tabs[0];
      console.log('[Popup] Current tab:', tab?.url);
      if (tab?.url?.includes('buff.163.com')) {
        setActiveTab(true);
        if (tab.id) {
          try {
            const result = await browser.tabs.sendMessage(tab.id, {
              type: MessageType.GET_ALL_GROUPS,
            });
            console.log('[Popup] GET_ALL_GROUPS result:', result);
            if (result?.groups) {
              setGroupList(result.groups);
              setSelectedGroups(new Set(result.groups.map((g: GroupInfo) => g.assetId)));
            }
          } catch (e) {
            console.error('[Popup] Failed to get groups:', e);
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
        case MessageType.LISTING_PROGRESS:
          setProgress(message.payload as ProcessProgress);
          break;
        case MessageType.LISTING_COMPLETE:
          setIsProcessing(false);
          setProgress(null);
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

  // 刷新商品组列表
  const refreshGroups = async () => {
    setLoading(true);
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      try {
        const result = await browser.tabs.sendMessage(tab.id, {
          type: MessageType.GET_ALL_GROUPS,
        });
        console.log('[Popup] Refresh groups result:', result);
        if (result?.groups) {
          setGroupList(result.groups);
          setSelectedGroups(new Set(result.groups.map((g: GroupInfo) => g.assetId)));
        }
      } catch (e) {
        console.error('[Popup] Failed to refresh groups:', e);
      } finally {
        setLoading(false);
      }
    }
  };

  const toggleWearRange = (rangeKey: string) => {
    setExpandedRanges(prev => {
      const newSet = new Set(prev);
      if (newSet.has(rangeKey)) {
        newSet.delete(rangeKey);
      } else {
        newSet.add(rangeKey);
      }
      return newSet;
    });
  };

  const handleStop = async () => {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;

    await browser.tabs.sendMessage(tab.id, { type: MessageType.STOP_PROCESS });
    setIsProcessing(false);
  };

  // 开始上架
  const handleStartListing = async () => {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;

    setIsProcessing(true);
    setError(null);

    await browser.tabs.sendMessage(tab.id, {
      type: MessageType.START_LISTING,
      payload: { groupDetails },
    });
  };

  const totalItems = groupDetails.reduce((sum, d) => sum + (d.items?.length || 0), 0);
  const totalValue = groupDetails.reduce(
    (sum, d) => sum + (d.items || []).reduce((s, i) => s + (i.suggestedPrice || 0), 0),
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
            <button onClick={refreshGroups} className="btn-refresh" title="刷新">
              🔄
            </button>
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
            {groupDetails.map((detail) => {
              const wearGroups = groupByWearRange(detail.items);
              return (
                <div key={detail.group.goodsId} className="item-group-card">
                  <div className="item-group-header">
                    <span className="item-group-name">
                      {detail.items[0]?.name || `商品组 ${detail.group.goodsId}`}
                    </span>
                    <span className="market-price">
                      最低 ¥{(detail.marketLowestPrice || 0).toFixed(2)}
                    </span>
                  </div>

                  {Array.from(wearGroups.entries()).map(([rangeKey, items]) => {
                    const isExpanded = expandedRanges.has(`${detail.group.goodsId}-${rangeKey}`);
                    const firstItem = items[0];
                    const groupTotalValue = items.reduce((sum, i) => sum + (i.suggestedPrice || 0), 0);

                    return (
                      <div key={rangeKey} className="wear-range-group">
                        <div
                          className="wear-range-header"
                          onClick={() => toggleWearRange(`${detail.group.goodsId}-${rangeKey}`)}
                        >
                          <div className="wear-range-info">
                            <span className="wear-range-toggle">{isExpanded ? '▼' : '▶'}</span>
                            <span className="wear-range-label">
                              磨损 {rangeKey}
                            </span>
                            <span className="wear-range-count">×{items.length}</span>
                          </div>
                          <div className="wear-range-pricing">
                            <PriceInput
                              value={firstItem?.suggestedPrice || 0.01}
                              onChange={(newPrice) => {
                                items.forEach(item => {
                                  updateItemPrice(detail.group.goodsId, item.assetId, newPrice);
                                });
                              }}
                            />
                            <span className="wear-range-total">= ¥{groupTotalValue.toFixed(2)}</span>
                          </div>
                        </div>

                        {isExpanded && (
                          <div className="wear-range-items">
                            {items.map((item) => (
                              <div key={item.assetId} className="item-row">
                                <div className="item-details">
                                  <p className="item-name">{item.name}</p>
                                  <p className="item-wear">磨损: {item.wear}</p>
                                </div>
                                <div className="item-pricing">
                                  <PriceInput
                                    value={item.suggestedPrice || 0.01}
                                    onChange={(newPrice) => {
                                      updateItemPrice(detail.group.goodsId, item.assetId, newPrice);
                                    }}
                                  />
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
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
                <button onClick={handleStartListing} className="btn-primary btn-compact">
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
