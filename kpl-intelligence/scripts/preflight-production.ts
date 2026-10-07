// Production deployment preflight verification script.
// Checks environment variables, TLS, database connectivity, connection pool budgets, and migration status.
//
// Usage:
//   node --env-file-if-exists=.env scripts/preflight-production.ts [--phase pre-migrate|post-migrate]
import { readdirSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";

const args = process.argv.slice(2);
const phaseIndex = args.indexOf("--phase");
const phase = phaseIndex !== -1 && args[phaseIndex + 1] ? args[phaseIndex + 1] : "post-migrate";

interface CheckResult {
  category: string;
  name: string;
  status: "PASS" | "WARN" | "FAIL";
  message: string;
}

const results: CheckResult[] = [];

function record(category: string, name: string, status: "PASS" | "WARN" | "FAIL", message: string) {
  results.push({ category, name, status, message });
}

console.log(`\n================================================================`);
console.log(`🚀 KPL Intelligence 生产上线预检 (Preflight Production Check)`);
console.log(`   阶段 (Phase): ${phase}`);
console.log(`   时间 (Timestamp): ${new Date().toISOString()}`);
console.log(`================================================================\n`);

// -------------------------------------------------------------
// 1. 环境变量与安全配置检查
// -------------------------------------------------------------
const env = process.env;

// DATABASE_URL
const rawDbUrl = env.DATABASE_URL;
if (!rawDbUrl) {
  record("Env & Security", "DATABASE_URL", "FAIL", "DATABASE_URL 环境变量未设置");
} else {
  try {
    const parsed = new URL(rawDbUrl);
    const host = parsed.hostname;
    const isLocal = host === "127.0.0.1" || host === "localhost" || host === "::1";
    const sslParam = parsed.searchParams.get("sslmode") || parsed.searchParams.get("ssl");

    if (isLocal && (env.NODE_ENV === "production" || env.AIHOT_ENVIRONMENT === "production")) {
      record("Env & Security", "DATABASE_URL Host", "WARN", `生产环境连接至本地数据库 (${host})，请确认是否符合预期`);
    } else {
      record("Env & Security", "DATABASE_URL Host", "PASS", `目标主机: ${host}:${parsed.port || 5432}`);
    }

    if (!isLocal && !sslParam) {
      record("Env & Security", "DATABASE_URL TLS", "WARN", "外部数据库连接串未显式指定 ?sslmode=require (系统已自动补充注入)");
    } else {
      record("Env & Security", "DATABASE_URL TLS", "PASS", `TLS 模式: ${sslParam || (isLocal ? "local (plain)" : "require")}`);
    }
  } catch (err) {
    record("Env & Security", "DATABASE_URL Format", "FAIL", `DATABASE_URL 格式非法: ${(err as Error).message}`);
  }
}

// SITE_URL
const siteUrl = env.SITE_URL;
if (!siteUrl) {
  record("Env & Security", "SITE_URL", "FAIL", "SITE_URL 未设置");
} else {
  try {
    const parsed = new URL(siteUrl);
    if (parsed.protocol !== "https:" && (env.NODE_ENV === "production" || env.AIHOT_ENVIRONMENT === "production")) {
      record("Env & Security", "SITE_URL HTTPS", "WARN", `SITE_URL (${siteUrl}) 未使用 HTTPS 协议`);
    } else {
      record("Env & Security", "SITE_URL", "PASS", `有效站点 URL: ${siteUrl}`);
    }
  } catch {
    record("Env & Security", "SITE_URL", "FAIL", `SITE_URL 格式无效: ${siteUrl}`);
  }
}

// ADMIN_PASSWORD
const adminPass = env.ADMIN_PASSWORD;
if (!adminPass) {
  record("Env & Security", "ADMIN_PASSWORD", "FAIL", "ADMIN_PASSWORD 未设置，后台无法安全登录");
} else if (adminPass.length < 12) {
  record("Env & Security", "ADMIN_PASSWORD Strength", "FAIL", `ADMIN_PASSWORD 长度仅 ${adminPass.length} 位，生产环境强制至少 12 位`);
} else {
  record("Env & Security", "ADMIN_PASSWORD", "PASS", "已设置且满足最低 12 位安全强度");
}

// SESSION_SECRET & IMG_PROXY_SIGN_SECRET
const sessionSecret = env.SESSION_SECRET;
if (!sessionSecret) {
  record("Env & Security", "SESSION_SECRET", "FAIL", "SESSION_SECRET 未设置");
} else if (sessionSecret.length < 32) {
  record("Env & Security", "SESSION_SECRET", "WARN", "SESSION_SECRET 建议至少 32 字符 (推荐 openssl rand -hex 32)");
} else {
  record("Env & Security", "SESSION_SECRET", "PASS", "已设置且符合推荐长度");
}

const imgSecret = env.IMG_PROXY_SIGN_SECRET;
if (!imgSecret) {
  record("Env & Security", "IMG_PROXY_SIGN_SECRET", "FAIL", "IMG_PROXY_SIGN_SECRET 未设置");
} else if (imgSecret.length < 32) {
  record("Env & Security", "IMG_PROXY_SIGN_SECRET", "WARN", "IMG_PROXY_SIGN_SECRET 建议至少 32 字符");
} else {
  record("Env & Security", "IMG_PROXY_SIGN_SECRET", "PASS", "已设置且符合推荐长度");
}

// Dev Auth Bypass Check
const devBypassKeys = Object.keys(env).filter((k) => k.startsWith("DEV_AUTH_"));
if (devBypassKeys.length > 0) {
  record("Env & Security", "Dev Auth Bypass", "FAIL", `检测到开发免密登录变量: ${devBypassKeys.join(", ")}，生产环境严禁配置`);
} else {
  record("Env & Security", "Dev Auth Bypass", "PASS", "未启用开发免密旁路");
}

if (env.ALLOW_PRIVATE_NETWORK_FETCH === "true" || env.ALLOW_PRIVATE_NETWORK_FETCH === "1") {
  record("Env & Security", "Private Network Fetch", "FAIL", "ALLOW_PRIVATE_NETWORK_FETCH 被设为 true，生产环境存在 SSRF 风险");
} else {
  record("Env & Security", "Private Network Fetch", "PASS", "私有内网抓取处于禁用状态");
}

// Connection Pool Budgets
const dbPoolMax = Number(env.DATABASE_POOL_MAX || 4);
if (dbPoolMax > 10) {
  record("Env & Security", "DATABASE_POOL_MAX", "WARN", `DATABASE_POOL_MAX=${dbPoolMax} 偏大，Supabase 免费/入门版易耗尽连接池 (推荐 3-5)`);
} else {
  record("Env & Security", "DATABASE_POOL_MAX", "PASS", `连接池上限配置: ${dbPoolMax}`);
}

const bossPoolMax = Number(env.PGBOSS_POOL_MAX || 2);
if (bossPoolMax > 5) {
  record("Env & Security", "PGBOSS_POOL_MAX", "WARN", `PGBOSS_POOL_MAX=${bossPoolMax} 偏大 (推荐 2)`);
} else {
  record("Env & Security", "PGBOSS_POOL_MAX", "PASS", `PgBoss 队列池上限: ${bossPoolMax}`);
}

// LLM
const modelCalls = env.MODEL_CALLS_ENABLED === "true";
if (modelCalls) {
  const llmKey = env.LLM_API_KEY || env.DEEPSEEK_API_KEY;
  if (!llmKey) {
    record("Env & Security", "LLM_API_KEY", "WARN", "MODEL_CALLS_ENABLED 为 true 但未检测到 LLM_API_KEY 或 DEEPSEEK_API_KEY");
  } else {
    record("Env & Security", "LLM Configuration", "PASS", `已配置模型调用密钥，端点: ${env.LLM_BASE_URL || "default"}`);
  }
} else {
  record("Env & Security", "MODEL_CALLS_ENABLED", "PASS", "MODEL_CALLS_ENABLED 为 false (安全离线/降级模式)");
}

// -------------------------------------------------------------
// 2. 数据库连通性、扩展与数据表状态检查
// -------------------------------------------------------------
try {
  const started = Date.now();
  const ping = await sql<{ ping: number }[]>`SELECT 1 AS ping`;
  const elapsed = Date.now() - started;
  if (ping[0]?.ping === 1) {
    record("Database", "Connectivity", "PASS", `连接正常，延迟: ${elapsed}ms`);
  } else {
    record("Database", "Connectivity", "FAIL", "SELECT 1 未返回预期结果");
  }

  // Postgres version
  const ver = await sql<{ version: string }[]>`SELECT version()`;
  record("Database", "Version", "PASS", (ver[0]?.version ?? "unknown").split(" on ")[0]!);

  // Required extensions
  const extensions = await sql<{ extname: string }[]>`SELECT extname FROM pg_extension`;
  const extSet = new Set(extensions.map((e) => e.extname));
  
  if (extSet.has("pg_trgm")) {
    record("Database", "Extension pg_trgm", "PASS", "已安装 (文本三元组索引)");
  } else {
    record("Database", "Extension pg_trgm", "FAIL", "未安装 pg_trgm 扩展，全文检索将不可用");
  }

  if (extSet.has("vector")) {
    record("Database", "Extension vector", "PASS", "已安装 (向量检索/HNSW)");
  } else {
    record("Database", "Extension vector", "FAIL", "未安装 vector 扩展，语义归组与向量索引不可用");
  }

  // Migrations check
  const migrationsDir = path.join(REPO_ROOT, "database/migrations");
  const localFiles = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();

  const hasMigrationsTable = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT FROM information_schema.tables 
      WHERE table_name = 'schema_migrations'
    )`;

  if (!hasMigrationsTable[0]?.exists) {
    if (phase === "pre-migrate") {
      record("Database", "Migrations Table", "PASS", `schema_migrations 尚未建立 (pre-migrate 阶段属于正常状态，待 migrate.ts 创建)`);
    } else {
      record("Database", "Migrations Table", "FAIL", "未发现 schema_migrations 表，尚未执行过数据库迁移！");
    }
  } else {
    const appliedRows = await sql<{ name: string }[]>`SELECT name FROM schema_migrations`;
    const appliedSet = new Set(appliedRows.map((r) => r.name));
    const missing = localFiles.filter((f) => !appliedSet.has(f));

    if (missing.length === 0) {
      record("Database", "Migrations Alignment", "PASS", `本地全部 ${localFiles.length} 个迁移文件已 100% 应用于数据库`);
    } else {
      if (phase === "pre-migrate") {
        record("Database", "Migrations Alignment", "WARN", `存在 ${missing.length} 个待应用迁移: ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? "..." : ""}`);
      } else {
        record("Database", "Migrations Alignment", "FAIL", `数据库缺失 ${missing.length} 个迁移: ${missing.join(", ")}，请先运行 npm run db:migrate`);
      }
    }
  }

  // Key business tables (KPL schema: sources, articles, stories, facts, teams, players, matches, heroes, seasons)
  const requiredTables = ["sources", "articles", "stories", "facts", "teams", "players", "matches", "heroes", "seasons"];
  const existingTables = await sql<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_name = ANY(${requiredTables})`;
  const existingSet = new Set(existingTables.map((t) => t.table_name));
  const missingTables = requiredTables.filter((t) => !existingSet.has(t));

  if (missingTables.length === 0) {
    record("Database", "Business Tables", "PASS", `核心业务表 (${requiredTables.join(", ")}) 均已就绪`);
  } else {
    if (phase === "pre-migrate") {
      record("Database", "Business Tables", "WARN", `尚未建立核心业务表: ${missingTables.join(", ")} (待 migrate 阶段创建)`);
    } else {
      record("Database", "Business Tables", "FAIL", `核心业务表缺失: ${missingTables.join(", ")}`);
    }
  }
} catch (err) {
  record("Database", "Connection Error", "FAIL", `数据库连接或查询异常: ${(err as Error).message}`);
} finally {
  await closeDb().catch(() => {});
}

// -------------------------------------------------------------
// 3. 输出汇总与结果判断
// -------------------------------------------------------------
const categories = [...new Set(results.map((r) => r.category))];
let passCount = 0;
let warnCount = 0;
let failCount = 0;

for (const cat of categories) {
  console.log(`[ ${cat} ]`);
  for (const item of results.filter((r) => r.category === cat)) {
    const symbol = item.status === "PASS" ? "✅ [PASS]" : item.status === "WARN" ? "⚠️  [WARN]" : "❌ [FAIL]";
    console.log(`  ${symbol} ${item.name.padEnd(28)} : ${item.message}`);
    if (item.status === "PASS") passCount += 1;
    else if (item.status === "WARN") warnCount += 1;
    else if (item.status === "FAIL") failCount += 1;
  }
  console.log("");
}

console.log(`================================================================`);
console.log(`📊 预检统计: 总计 ${results.length} 项 | 通过: ${passCount} | 警告: ${warnCount} | 失败: ${failCount}`);

if (failCount > 0) {
  console.log(`🚨 预检未通过！存在 ${failCount} 项致命阻断问题，请修复后再次运行。`);
  process.exit(1);
} else {
  console.log(`🎉 预检通过！系统环境满足 ${phase} 阶段上线与运行要求。`);
  process.exit(0);
}
