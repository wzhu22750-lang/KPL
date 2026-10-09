import { sql } from '../db.ts';
import { promptText, promptVersion } from './prompts.ts';
import { modelFor } from './models.ts';
import { chatJson } from '../providers/llm.ts';
import { completeReceipt } from '../providers/receipts.ts';
import { extractArticleBody, pageFetchable } from '../content/extract.ts';
import { latestEngagement } from '../content/engagement.ts';
import { RadarJudgment, radarScore, radarAdmission, type RadarJudgmentData } from './radar-score.ts';
import { associateMatch, type RadarMatchCandidate } from '../events/radar-match.ts';
import { RADAR } from '@aihot/industry/radar';
import { canonicalEvidenceHash, canonicalEvidenceText } from '../content/canonical.ts';

export async function assessRadar(articleId: string) {
  const load = () => sql<{ id: string; revision: number; title: string; body_text: string | null; excerpt: string | null; published_at: Date | null;
    discovered_at: Date; url: string; body_status: string; canonical_content: Record<string,any> | null;
    kind: string; source_id: string; enabled: boolean; participation_mode: string; official: boolean }[]>`
    SELECT a.id,a.revision,a.title,a.body_text,a.excerpt,a.published_at,a.discovered_at,a.url,a.body_status,a.canonical_content,
      s.kind,s.id AS source_id,s.enabled,s.participation_mode,
      (s.owner_type IN ('league','club') AND EXISTS (SELECT 1 FROM entity_accounts ea WHERE ea.source_id=s.id AND ea.official_verified AND ea.active)) AS official
    FROM articles a JOIN sources s ON s.id=a.source_id WHERE a.id=${articleId}`;
  let [a] = await load();
  if (!a || !a.enabled || a.participation_mode === 'isolated') return { state: 'skipped' };
  try {
    // Community signals were never guaranteed to enter the legacy extraction queue. Fetch their
    // actual body here before judging, retaining the same canonical extractor and revision rules.
    if (!a.body_text && a.body_status === 'pending' && pageFetchable(a.url,a.kind)) {
      await extractArticleBody(articleId);
      [a] = await load();
      if (!a) return { state: 'missing' };
    }
    const canonicalText = a.canonical_content ? canonicalEvidenceText(a.canonical_content as any) : '';
    const evidenceText = canonicalText.trim().length > 0 ? canonicalText : (a.body_text ?? a.excerpt ?? '');
    if (!evidenceText.trim() && !a.body_text && !a.excerpt) throw new Error('review: original body unavailable; title alone is insufficient');
    if (evidenceText.length > 30000) throw new Error('review: material exceeds radar input limit; no silent truncation');
    const evidenceHash = canonicalEvidenceHash(a.canonical_content, {
      title: a.title,
      bodyText: a.body_text,
      excerpt: a.excerpt,
    });
    const [old] = await sql<{ input_revision: number; score_version: string; judgment: RadarJudgmentData; receipt_id: number | null; input_evidence_hash: string | null }[]>`
      SELECT input_revision,score_version,judgment,receipt_id,input_evidence_hash FROM radar_materials WHERE article_id=${articleId}`;
    let judgment: RadarJudgmentData;
    let receiptId: number | null;
    if (
      old?.input_revision === a.revision &&
      old.score_version === RADAR.version &&
      old.input_evidence_hash !== null &&
      old.input_evidence_hash === evidenceHash
    ) {
      judgment = RadarJudgment.parse(old.judgment); receiptId = old.receipt_id;
    } else {
      const topicCandidates = await sql`SELECT topic_key,title FROM radar_topics
        WHERE last_development_at BETWEEN ${new Date((a.published_at ?? a.discovered_at).getTime()-7*86400000)}
          AND ${new Date((a.published_at ?? a.discovered_at).getTime()+86400000)} ORDER BY last_development_at DESC LIMIT 30`;
      const result = await chatJson({ model: await modelFor('understand'), purpose: 'radar_judge', subject: `radar:${articleId}@${a.revision}`,
        promptVersion: promptVersion('radar-judge') + ':' + RADAR.version, system: promptText('radar-judge'),
        user: JSON.stringify({ title: a.title, publishedAt: a.published_at, topicCandidates, original: evidenceText, completeness: a.canonical_content?.quality?.completeness ?? 'unknown' }),
        schema: RadarJudgment, temperature: 0.2, maxTokens: 2400, timeoutMs: 120000 });
      judgment = result.data; receiptId = result.receiptId;
    }
    const fullOriginal = [a.title, evidenceText].filter(Boolean).join('\n');
    judgment = { ...judgment, evidence: judgment.evidence.filter(q => fullOriginal.includes(q)) };
    const latest = (await latestEngagement(sql,articleId)).find(o => o.source_id === a!.source_id);
    const [previous] = latest ? await sql<{ platform: string; observed_at: Date; metrics: any }[]>`
      SELECT platform,observed_at,metrics FROM engagement_observations WHERE article_id=${articleId} AND source_id=${a.source_id}
        AND platform=${latest.platform} AND observed_at < ${latest.observed_at} ORDER BY observed_at DESC LIMIT 1` : [];
    const score = radarScore(judgment,a.official,
      latest ? { platform:latest.platform,observedAt:latest.observed_at,metrics:latest.metrics } : undefined,
      previous ? { platform:previous.platform,observedAt:previous.observed_at,metrics:previous.metrics } : undefined);
    const state = judgment.relevant && judgment.evidence.length === 0 ? 'review' : radarAdmission(judgment,score);
    const at = a.published_at ?? a.discovered_at;
    const matches = await sql<(RadarMatchCandidate & { at: Date })[]>`
      SELECT m.id,ta.name AS "homeName",tb.name AS "awayName",coalesce(m.scheduled_at,m.played_at) AS at,
        concat(se.name,' ',m.stage) AS stage,m.bo,m.status FROM matches m JOIN teams ta ON ta.id=m.team_a_id
        JOIN teams tb ON tb.id=m.team_b_id JOIN seasons se ON se.id=m.season_id
      WHERE coalesce(m.scheduled_at,m.played_at) BETWEEN ${new Date(at.getTime()-3*86400000)} AND ${new Date(at.getTime()+86400000)}`;
    // Only original material identifies a match/game; an AI headline must not create that identity.
    const association = associateMatch(fullOriginal,a.published_at,matches);
    return await sql.begin(async tx => {
      const [current] = await tx<{
        revision: number;
        body_text: string | null;
        canonical_content: any;
        source_id: string;
        enabled: boolean;
        participation_mode: string;
      }[]>`
        SELECT a.revision, a.body_text, a.canonical_content, a.source_id, s.enabled, s.participation_mode
        FROM articles a JOIN sources s ON s.id=a.source_id WHERE a.id=${articleId} FOR UPDATE OF a`;
      if (!current || !current.enabled || current.participation_mode === 'isolated' || current.source_id !== a!.source_id) {
        return { state: 'skipped' };
      }
      if (current.revision !== a!.revision) return { state: 'stale' };

      const currentEvidenceHash = canonicalEvidenceHash(current.canonical_content, {
        title: a!.title,
        bodyText: current.body_text,
        excerpt: a!.excerpt,
      });
      if (currentEvidenceHash !== evidenceHash) return { state: 'stale' };
      let topicId: number | null = null;
      if (state === 'accepted' && judgment.topicKey && (judgment.kind === 'controversy' || judgment.kind === 'fun')) {
        const key = judgment.topicKey.toLowerCase().replace(/\s+/g,' ').trim();
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`radar-topic:${key}`}))`;
        const [topic] = await tx`SELECT id FROM radar_topics WHERE topic_key=${key}
          AND last_development_at BETWEEN ${new Date(at.getTime()-7*86400000)} AND ${new Date(at.getTime()+86400000)} ORDER BY last_development_at DESC LIMIT 1`;
        topicId = topic ? Number(topic.id) : Number((await tx`INSERT INTO radar_topics(topic_key,title,last_development_at)
          VALUES (${key},${judgment.title},${at}) RETURNING id`)[0]!.id);
        // A repeated judgement or a newly observed like does not resurface an old conflict.
        if (judgment.newDevelopment && old?.input_revision !== a!.revision) {
          await tx`UPDATE radar_topics SET last_development_at=greatest(last_development_at,${at}) WHERE id=${topicId}`;
        }
      }
      await tx`INSERT INTO radar_materials(article_id,input_revision,state,kind,title,summary,claim_status,stance,evidence,judgment,
        base_score,official_bonus,noise,score_version,reason,topic_id,match_id,game_no,association_evidence,receipt_id,input_evidence_hash)
        VALUES (${articleId},${a!.revision},${state},${judgment.kind},${judgment.title},${judgment.summary},${judgment.claimStatus},${judgment.stance},
          ${tx.json(judgment.evidence)},${tx.json(judgment)},${score.base},${score.official},${score.noise},${score.version},${score.reason},
          ${topicId},${association?.matchId ?? null},${association?.gameNo ?? null},${association?.evidence ?? null},${receiptId},${evidenceHash})
        ON CONFLICT(article_id) DO UPDATE SET input_revision=EXCLUDED.input_revision,state=EXCLUDED.state,kind=EXCLUDED.kind,
          title=EXCLUDED.title,summary=EXCLUDED.summary,claim_status=EXCLUDED.claim_status,stance=EXCLUDED.stance,evidence=EXCLUDED.evidence,
          judgment=EXCLUDED.judgment,base_score=EXCLUDED.base_score,official_bonus=EXCLUDED.official_bonus,noise=EXCLUDED.noise,
          score_version=EXCLUDED.score_version,reason=EXCLUDED.reason,topic_id=EXCLUDED.topic_id,match_id=EXCLUDED.match_id,
          game_no=EXCLUDED.game_no,association_evidence=EXCLUDED.association_evidence,receipt_id=EXCLUDED.receipt_id,
          input_evidence_hash=EXCLUDED.input_evidence_hash,evaluated_at=now()`;
      if (receiptId) await completeReceipt(tx,receiptId);
      await tx`DELETE FROM radar_failures WHERE article_id=${articleId}`;
      return { state, score };
    });
  } catch (error) {
    await sql`INSERT INTO radar_failures(article_id,input_revision,error) VALUES (${articleId},${a.revision},${String(error).slice(0,500)})
      ON CONFLICT(article_id) DO UPDATE SET input_revision=EXCLUDED.input_revision,error=EXCLUDED.error,attempted_at=now()`;
    throw error;
  }
}
