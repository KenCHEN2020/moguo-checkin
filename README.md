# 摸果子登记

一条共享链接的摸果 / 种果登记页，纯静态，数据存 Supabase。

## 文件

- `index.html` 页面（管理台加 `?admin=mg-a7f3kq9z2`）
- `supabase-db.js` 数据层，直连 Supabase REST，不依赖外部 SDK
- `supabase-schema.sql` 建表 + RLS 策略
- `supabase-data.sql` 数据导入

## 配置

在 `index.html` 顶部 `APP_CONFIG` 修改 `backend` / `supabaseUrl` / `supabaseKey`。
