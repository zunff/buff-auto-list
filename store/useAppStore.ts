import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { GroupDetail, ProcessProgress } from '@/utils/message';

interface AppState {
  // 运行状态
  isProcessing: boolean;

  // 当前标签页
  activeTabId: number | null;

  // 处理进度
  progress: ProcessProgress | null;

  // 商品组详情列表
  groupDetails: GroupDetail[];

  // 选中的商品（用于上架确认）
  selectedItems: Set<string>;

  // 错误信息
  error: string | null;

  // Actions
  setIsProcessing: (processing: boolean) => void;
  setActiveTabId: (tabId: number | null) => void;
  setProgress: (progress: ProcessProgress | null) => void;
  addGroupDetail: (detail: GroupDetail) => void;
  setGroupDetails: (details: GroupDetail[]) => void;
  toggleSelectedItem: (assetId: string) => void;
  setSelectedItems: (items: Set<string>) => void;
  setError: (error: string | null) => void;
  reset: () => void;
}

const initialState = {
  isProcessing: false,
  activeTabId: null,
  progress: null,
  groupDetails: [],
  selectedItems: new Set<string>(),
  error: null,
};

// 自定义存储适配器，使用 extension storage
const extensionStorage = {
  getItem: async (name: string): Promise<string | null> => {
    try {
      const result = await browser.storage.local.get(name);
      return (result[name] as string | undefined) || null;
    } catch {
      return null;
    }
  },
  setItem: async (name: string, value: string): Promise<void> => {
    try {
      await browser.storage.local.set({ [name]: value });
    } catch (error) {
      console.error('[Store] Failed to save to storage:', error);
    }
  },
  removeItem: async (name: string): Promise<void> => {
    try {
      await browser.storage.local.remove(name);
    } catch (error) {
      console.error('[Store] Failed to remove from storage:', error);
    }
  },
};

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      ...initialState,

      setIsProcessing: (isProcessing) => set({ isProcessing }),
      setActiveTabId: (activeTabId) => set({ activeTabId }),
      setProgress: (progress) => set({ progress }),
      addGroupDetail: (detail) =>
        set((state) => ({
          groupDetails: [...state.groupDetails, detail],
        })),
      setGroupDetails: (groupDetails) => set({ groupDetails }),
      toggleSelectedItem: (assetId) =>
        set((state) => {
          const newSelected = new Set(state.selectedItems);
          if (newSelected.has(assetId)) {
            newSelected.delete(assetId);
          } else {
            newSelected.add(assetId);
          }
          return { selectedItems: newSelected };
        }),
      setSelectedItems: (selectedItems) => set({ selectedItems }),
      setError: (error) => set({ error }),
      reset: () => set(initialState),
    }),
    {
      name: 'buff-auto-list-storage',
      storage: createJSONStorage(() => extensionStorage),
      // 不持久化运行时状态
      partialize: () => ({}),
    }
  )
);
