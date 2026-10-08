# 移动端信息层次优化方案

## 📱 问题诊断

通过代码审查发现移动端存在三大问题：

### 1. 信息密度过高
- **元信息过载**：单个卡片头部挤入来源、分组、时间、评分、收藏等 6-8 个元素
- **字号梯度不足**：标题 17px → 摘要 14.5px → 元信息 12.5px，层级差仅 25%
- **垂直留白不足**：卡片内边距 20px，卡片间距 20px，缺乏呼吸感

### 2. 视觉层次不清
- **缺少主次对比**：所有卡片都是白底 + 1px 细边框，重要内容不突出
- **已读状态不明显**：仅靠 `text-ink-4` 颜色降权，缺乏整体视觉变化
- **操作反馈不足**：点击态、悬停态（触摸屏不适用）缺失

### 3. 信息分组混乱
- **时间信息重复**：桌面版在时间轴显示，移动版在卡片内重复
- **次要信息抢眼**：分组标签、评分与标题处于同一视觉层级
- **折叠逻辑不统一**：部分内容用 `details`，部分用按钮，交互不一致

---

## 🎯 解决方案

### 核心原则

1. **信息金字塔**：标题 (L1) > 摘要 (L2) > 元信息 (L3) > 操作 (L4)
2. **视觉降噪**：隐藏非关键元素，通过交互按需展开
3. **呼吸感留白**：垂直间距提升 40%，卡片内边距从 20px → 24px
4. **状态差异化**：已读/未读、普通/重点用背景色+阴影区分

---

## 🛠️ 实施方案

### 方案 A：渐进式改进（推荐 ⭐）

**优点**：不破坏现有代码，可 A/B 测试
**实施步骤**：

#### Step 1: 引入新样式（立即可用）

在 `apps/web/app/routes/home.tsx` 顶部添加：

```tsx
import '../features/feed/feed-mobile-hierarchy.css';
```

#### Step 2: 可选 - 使用独立移动端组件

在 `features/feed/Timeline.tsx` 中根据屏幕尺寸按需渲染：

```tsx
import { FeedItem } from './FeedItem';
import { FeedItemMobile } from './FeedItem.mobile';

// 在 TimelineSlot 返回前添加判断
export function TimelineSlot({ at, children, ... }: TimelineSlotProps) {
  const [isMobile, setIsMobile] = useState(false);
  
  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth <= 960);
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  return (
    <li data-card-key={dataKey} className="...">
      <div className="grid ...">
        {/* 时间轴 */}
        <time>...</time>
        
        {/* 按屏幕尺寸渲染不同组件 */}
        {isMobile ? (
          <FeedItemMobile 
            item={card.item} 
            read={isRead} 
            onOpen={open} 
            at={at} 
            showDate={showDate} 
          />
        ) : (
          <FeedItem 
            item={card.item} 
            read={isRead} 
            onOpen={open} 
            at={at} 
            showDate={showDate} 
          />
        )}
      </div>
    </li>
  );
}
```

#### Step 3: 中期重构（可选）

统一 `FeedItem.tsx` 内部用 CSS 媒体查询自适应，移除 `FeedItem.mobile.tsx`。

---

### 方案 B：快速验证（测试用）

直接在 `apps/web/app/features/feed/home-mobile.css` 末尾追加以下内容：

```css
/* ========== 移动端层次增强（快速测试版）========== */
@media (max-width: 960px) {
  /* 标题字号提升 + 加粗 */
  .home-overview .feed-headline {
    font-size: 19px !important;
    font-weight: 700 !important;
    margin-top: 16px !important;
  }

  /* 卡片内边距增加 */
  .home-overview [data-item-id] {
    padding: 24px 20px !important;
  }

  /* 卡片间距增加 */
  .home-overview [data-card-key] {
    margin-bottom: 16px !important;
  }

  /* 元信息视觉降权 */
  .home-overview .feed-meta {
    opacity: 0.7 !important;
  }

  .home-overview .feed-source {
    background: transparent !important;
    border: 0 !important;
    padding: 0 !important;
  }

  /* 高优先级内容高亮 */
  .home-overview [data-item-id]:has([data-score-tier="A"]),
  .home-overview [data-item-id]:has([data-score-tier="S"]) {
    border-color: var(--accent-soft) !important;
    box-shadow: 0 2px 6px rgba(59, 109, 255, 0.08) !important;
  }

  /* 点击反馈 */
  .home-overview [data-item-id]:active {
    transform: scale(0.98);
    transition: transform 0.1s ease;
  }
}
```

---

## 📊 对比效果

### 改进前
```
┌─────────────────────────────┐
│ 来源 · 分组 · 时间 · 评分 ⭐│ ← 8 个元素挤在一行
├─────────────────────────────┤
│ 标题标题标题标题标题        │ ← 17px
│                             │
│ 摘要摘要摘要摘要摘要摘要    │ ← 14.5px
└─────────────────────────────┘
   ↑ 20px 间距
```

### 改进后
```
┌─────────────────────────────┐
│                             │ ← 24px 顶部留白
│ 标题标题标题标题标题        │ ← 19px 加粗
│                             │
│ 摘要摘要摘要摘要摘要摘要    │ ← 15.5px
│                             │
├─────────────────────────────┤ ← 分隔线
│ 来源 · 时间      评分 ⭐    │ ← 12.5px，背景灰色
└─────────────────────────────┘
   ↑ 16px 间距（视觉更轻盈）
```

---

## 🎨 视觉层级设计

### L1: 标题（最重要）
- **字号**: 19px（从 17px 提升 12%）
- **字重**: 700（从 650 加粗）
- **颜色**: `--ink`（最高对比度）
- **行间距**: 1.5（适度紧凑）
- **字距**: -0.015em（微负值，更紧凑）

### L2: 摘要（次要）
- **字号**: 15.5px（从 15px 微调）
- **字重**: 400（正常）
- **颜色**: `--ink-2`（中等对比度）
- **行间距**: 1.75（阅读舒适）
- **行数限制**: 2 行（超长省略）

### L3: 元信息（辅助）
- **字号**: 12.5px（不变）
- **字重**: 500（来源名称）/ 400（时间）
- **颜色**: `--ink-3` / `--ink-4`（低对比度）
- **位置**: 移到底部 footer，背景灰色隔离
- **不透明度**: 0.75（整体降权）

### L4: 操作（按需）
- **评分**: 相对定位，右上角
- **收藏**: 44px 触摸区，右下角
- **多来源**: 浮动按钮，需要时展开

---

## ✅ 验收标准

### 视觉测试

1. **字号梯度明显**：标题在 3 米外可识别，摘要在 1.5 米外可读
2. **留白舒适**：单屏显示 3-4 条内容（iPhone 14 Pro 6.1 寸）
3. **已读状态清晰**：已读卡片整体灰度降低 40%

### 交互测试

1. **点击反馈**：卡片点击时有 0.98 缩放动画（100ms）
2. **滚动流畅**：60fps 无卡顿（用 Chrome DevTools Performance 测试）
3. **收藏操作**：44×44px 触摸区，误触率 < 5%

### 信息测试

1. **5 秒扫读**：用户能快速识别 5 条标题
2. **信息完整**：折叠元信息后，核心信息（标题+摘要）无损失
3. **操作可达**：所有操作在单手可触达区域（底部 1/3 屏幕）

---

## 🚀 部署计划

### 第 1 天：引入新样式
- [ ] 在 `home.tsx` 引入 `feed-mobile-hierarchy.css`
- [ ] 在真机测试（iOS Safari + Android Chrome）
- [ ] 截图对比前后效果

### 第 2-3 天：A/B 测试
- [ ] 50% 用户看到新版（通过 feature flag）
- [ ] 收集数据：跳出率、停留时长、点击率
- [ ] 调整字号/间距细节

### 第 4-7 天：全量上线
- [ ] 根据 A/B 测试结果调优
- [ ] 全量发布新版移动端
- [ ] 监控性能指标（LCP < 2.5s）

---

## 🔍 后续优化方向

1. **虚拟滚动**：长列表（>50 条）用 `@tanstack/react-virtual` 优化内存
2. **骨架屏**：首次加载显示占位符，减少 CLS（累积布局偏移）
3. **手势操作**：侧滑卡片快速收藏/标记已读
4. **智能折叠**：连续 3 条同来源自动折叠为"来自 XX 的 3 条更新"

---

## 📝 相关文件

- **新增样式**: `apps/web/app/features/feed/feed-mobile-hierarchy.css`
- **新增组件**: `apps/web/app/features/feed/FeedItem.mobile.tsx`
- **修改入口**: `apps/web/app/routes/home.tsx`（导入新样式）
- **可选修改**: `apps/web/app/features/feed/Timeline.tsx`（响应式组件切换）

---

## 💡 设计理念

这次优化遵循 **信息极简主义**（Information Minimalism）原则：

> **在移动端，用户的注意力是稀缺资源。**  
> 我们的目标不是展示所有信息，而是让用户在 3 秒内抓住核心内容，  
> 在 5 秒内决定是否深入阅读，在 10 秒内完成收藏/分享操作。

参考案例：
- **Twitter (X) 移动端**：标题 + 预览图 + 互动数据，元信息极简
- **Apple News**：大标题 + 摘要 + 全屏图，沉浸式阅读
- **Perplexity**：问题 → 答案 → 来源，清晰的信息层级

KPL Intelligence 作为专业电竞资讯平台，需要在**信息密度**（给核心用户足够细节）与**易读性**（让新用户快速上手）之间找到平衡。这次优化通过**渐进式信息披露**（Progressive Disclosure）实现了这一点。
