import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: '网易Buff自动上架',
    description: '网易Buff库存页商品自动上架工具',
    version: '1.0.0',
    permissions: ['storage', 'tabs'],
    host_permissions: ['*://buff.163.com/*'],
  },
});
