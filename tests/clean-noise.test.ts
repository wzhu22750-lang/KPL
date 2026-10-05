import assert from "node:assert/strict";
import test from "node:test";
import { pruneHtmlNoise, pruneTextNoise } from "@aihot/backend/content/clean-noise";

test("Clean Noise - 剔除用户反馈的典型末尾招聘、求报道与推荐阅读噪点", () => {
  const articleWithNoise = `
# 鸟巢里的KPL年度总决赛

在这一天的年度总决赛上，胜负或许总有些让人期待能发生逆转。最终靠着下路龙兵平推，以4比2的比分结束了整场比赛。在全场爆发的欢呼声、金色的彩带飘雨中，成都AG超玩会成功蝉联年度总冠军。

今年是KPL的第9年，明年是第10年。我很期待看到它未来的样子。

**编辑 王琳茜**

事已至此，你洗碗吧

**触乐正在招聘文字编辑，欢迎加入触乐**如果您有什么新鲜事想告诉我们，**想爆料**，或者您希望您自己、团队或者产品**被我们报导**，点击填写求报道问卷 我们收到后就会联系您。

***觉得不错点个*****🤍*****吧***

**推荐阅读**

[入行剧情策划指南](https://example.com/1)**丨**[大厂外派](https://example.com/2)

[Cos委托](https://example.com/3)**丨**[国乙婚卡](https://example.com/4)

[专访CDPR](https://example.com/5)**丨**[版号简史](https://example.com/6)

每天推送头条评论区会抽2位朋友赠送价值3美元的Steam国区充值卡，来评论吧！

🎈

👇关注后点，点左上“•••”设为⭐星标，不错过下一篇你感兴趣的文章推送
  `.trim();

  const cleaned = pruneTextNoise(articleWithNoise);

  // 必须保留正文深度内容
  assert.ok(cleaned.includes("成都AG超玩会成功蝉联年度总冠军"));
  assert.ok(cleaned.includes("我很期待看到它未来的样子。"));

  // 必须彻底剔除所有尾部噪点
  assert.ok(!cleaned.includes("编辑 王琳茜"), "应剔除编辑署名与口头禅");
  assert.ok(!cleaned.includes("事已至此，你洗碗吧"));
  assert.ok(!cleaned.includes("触乐正在招聘文字编辑"), "应剔除招聘启事");
  assert.ok(!cleaned.includes("求报道问卷"), "应剔除求报道问卷");
  assert.ok(!cleaned.includes("觉得不错点个"), "应剔除点赞在看引导");
  assert.ok(!cleaned.includes("推荐阅读"), "应剔除推荐阅读标题");
  assert.ok(!cleaned.includes("入行剧情策划指南"), "应剔除无关文章推荐链接");
  assert.ok(!cleaned.includes("Steam国区充值卡"), "应剔除充值卡抽奖活动");
  assert.ok(!cleaned.includes("设为⭐星标"), "应剔除星标引导");
});

test("Clean Noise - HTML 尾部噪点净化", () => {
  const htmlWithNoise = `
    <h2>正文标题</h2>
    <p>这是关于 2026 KPL 年总的深度分析与精彩赛况内容。</p>
    <p>期待未来更多精彩对决。</p>
    <p><strong>推荐阅读</strong></p>
    <p><a href="https://example.com/old1">往期文章一</a></p>
    <p><a href="https://example.com/old2">往期文章二</a></p>
    <p>关注后点左上设为星标</p>
  `;

  const cleanedHtml = pruneHtmlNoise(htmlWithNoise);

  assert.ok(cleanedHtml.includes("这是关于 2026 KPL 年总的深度分析"));
  assert.ok(!cleanedHtml.includes("推荐阅读"));
  assert.ok(!cleanedHtml.includes("往期文章一"));
  assert.ok(!cleanedHtml.includes("设为星标"));
});
