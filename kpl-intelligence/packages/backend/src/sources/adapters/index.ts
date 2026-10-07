export * from "./types.ts";
export * from "./registry.ts";
export * from "./base.ts";
export * from "./weibo.ts";

import { registerAdapter } from "./registry.ts";
import { WeiboAdapter } from "./weibo.ts";

// 注册系统内置适配器
registerAdapter(new WeiboAdapter());
