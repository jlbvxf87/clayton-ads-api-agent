import 'dotenv/config';
import axios from 'axios';
import Anthropic from '@anthropic-ai/sdk';
import TelegramBot from 'node-telegram-bot-api';
import { supabase } from './supabase.js';
import { getCampaignInsights, getActionBreakdown, extractLeads } from './meta.js';
import { cioCountEvents, cioDiscoverEventNames, CIO_CONFIGURED } from './customerio.js';

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-7';
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SCREENSHOTONE_KEY = process.env.SCREENSHOTONE_ACCESS_KEY ?? null;

if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY required');
if (!TELEGRAM_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN required');

const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

// ---------- Types ----------

export interface Competitor {
  id: number;
  url: string;
  label: string | null;
  type: 'landing_page' | 'ad_library' | 'blog' | 'other';
  enabled: boolean;
  notes: string | null;
  created_at: string;
}

export interface FirstScrollAnalysis {
  hero_headline: string | null;
  subhead: string | null;
  primary_cta: { copy: string; position: 'top' | 'middle' | 'bottom'; color_hint: string | null } | null;
  secondary_cta: string | null;
  bullets: string[];
  social_proof: string[];
  badges: string[];
  urgency_elements: string[];
  pricing_visible: string | null;
  payment_options: string[];
  cta_layout: 'single' | 'multiple' | 'sticky_bottom' | 'navigation_only';
  visual_style: string;
  observed_patterns: string[];
}

export interface LpRecommendation {
  id?: number;
  hypothesis: string;
  evidence: string[];
  competitor_evidence: string[];
  claya_data_evidence: string[];
  implementation_steps: string[];
  expected_lift_band: 'low' | 'medium' | 'high';
  expected_lift_pct: number | null;
  priority: number;
}

interface SnapshotRow {
  id: number;
  competitor_id: number | null;
  url: string;
  captured_at: string;
  parsed_structure: FirstScrollAnalysis | null;
  rendered_html_excerpt: string | null;
}

// ---------- Competitor CRUD ----------

export async function listCompetitors(includeDisabled = false): Promise<Competitor[]> {
  let q = supabase.from('lp_competitors').select('*').order('created_at', { ascending: true });
  if (!includeDisabled) q = q.eq('enabled', true);
  const { data, error } = await q;
  if (error) {
    console.error('[LP] listCompetitors failed:', error.message);
    return [];
  }
  return (data ?? []) as Competitor[];
}

export async function addCompetitor(args: {
  url: string;
  label?: string;
  type?: Competitor['type'];
  notes?: string;
}): Promise<Competitor> {
  const { data, error } = await supabase
    .from('lp_competitors')
    .upsert(
      {
        url: args.url,
        label: args.label ?? null,
        type: args.type ?? 'landing_page',
        notes: args.notes ?? null,
        enabled: true,
      },
      { onConflict: 'url' },
    )
    .select()
    .single();
  if (error || !data) throw new Error(`addCompetitor: ${error?.message}`);
  return data as Competitor;
}

export async function setCompetitorEnabled(id: number, enabled: boolean): Promise<void> {
  const { error } = await supabase.from('lp_competitors').update({ enabled }).eq('id', id);
  if (error) throw new Error(`setCompetitorEnabled: ${error.message}`);
}

export async function removeCompetitor(id: number): Promise<void> {
  const { error } = await supabase.from('lp_competitors').delete().eq('id', id);
  if (error) throw new Error(`removeCompetitor: ${error.message}`);
}

// ---------- Capture: screenshot + html ----------

interface CaptureResult {
  png_base64: string | null;
  png_size_bytes: number;
  rendered_html: string | null;
  text_excerpt: string;
  error: string | null;
}

export const SCREENSHOT_AVAILABLE = SCREENSHOTONE_KEY != null;

async function captureScreenshot(url: string): Promise<{ base64: string | null; size: number; error: string | null }> {
  if (!SCREENSHOTONE_KEY) {
    return { base64: null, size: 0, error: 'SCREENSHOTONE_ACCESS_KEY not set — skipping screenshot' };
  }
  try {
    const res = await axios.get('https://api.screenshotone.com/take', {
      params: {
        url,
        access_key: SCREENSHOTONE_KEY,
        format: 'png',
        viewport_width: 390,
        viewport_height: 844,
        device_scale_factor: 2,
        full_page: false,
        block_ads: true,
        block_cookie_banners: true,
        block_chats: true,
        cache: false,
        delay: 2,
        image_quality: 80,
      },
      responseType: 'arraybuffer',
      timeout: 30000,
      validateStatus: () => true,
    });
    if (res.status >= 400) {
      return { base64: null, size: 0, error: `screenshotone http ${res.status}: ${Buffer.from(res.data).toString('utf-8').slice(0, 200)}` };
    }
    const buf = Buffer.from(res.data);
    return { base64: buf.toString('base64'), size: buf.byteLength, error: null };
  } catch (err) {
    return { base64: null, size: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

async function fetchHtmlFallback(url: string): Promise<{ html: string | null; error: string | null }> {
  try {
    const res = await axios.get(url, {
      timeout: 20000,
      maxContentLength: 5_000_000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml',
      },
      validateStatus: () => true,
    });
    if (res.status >= 400) return { html: null, error: `http ${res.status}` };
    return { html: typeof res.data === 'string' ? res.data : String(res.data), error: null };
  } catch (err) {
    return { html: null, error: err instanceof Error ? err.message : String(err) };
  }
}

function stripHtmlToText(html: string): string {
  // Quick-and-dirty text extraction. We don't need perfection — Claude can
  // parse messy text. Strip scripts/styles, decode common entities, normalize
  // whitespace, cap length.
  const noScript = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  const noTags = noScript.replace(/<[^>]+>/g, ' ');
  const decoded = noTags
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  return decoded.replace(/\s+/g, ' ').trim().slice(0, 8000);
}

export async function captureUrl(url: string): Promise<CaptureResult> {
  const [shotResult, htmlResult] = await Promise.all([
    captureScreenshot(url),
    fetchHtmlFallback(url),
  ]);
  const errorMessages: string[] = [];
  if (shotResult.error) errorMessages.push(`screenshot: ${shotResult.error}`);
  if (htmlResult.error) errorMessages.push(`html: ${htmlResult.error}`);
  const textExcerpt = htmlResult.html ? stripHtmlToText(htmlResult.html) : '';
  return {
    png_base64: shotResult.base64,
    png_size_bytes: shotResult.size,
    rendered_html: htmlResult.html ? htmlResult.html.slice(0, 50000) : null,
    text_excerpt: textExcerpt,
    error: errorMessages.length > 0 ? errorMessages.join(' | ') : null,
  };
}

// ---------- Vision/text analysis ----------

const ANALYSIS_SYSTEM = `You are analyzing the FIRST SCROLL of a competitor landing page in the direct-response/health-supplement/telehealth space. Your output is structured data — fill the submit_lp_analysis tool with what you see.

Rules:
- Hero headline = the main value-proposition text visible on first scroll.
- Subhead = the smaller text that elaborates the hero.
- Primary CTA = the button or link you'd hit first; capture exact copy + visual position (top/middle/bottom of viewport) + a color hint if obvious (e.g. "green pill", "yellow rectangle").
- Secondary CTA = any secondary button/link (e.g. "learn more", "watch video"). Null if none.
- Bullets = short benefit/feature claims if shown as a list.
- Social proof = review counts, ratings, stars, named customer counts. Each one as a string.
- Badges = trust marks: HIPAA, BBB, Made in USA, FSA/HSA, FDA, etc.
- Urgency elements = countdowns, "limited time", "X seats left", flash sale text.
- Pricing visible = the actual price shown above-the-fold (e.g. "$159/mo", "$299 → $159"). Null if hidden behind a quiz/form.
- Payment options = Klarna, Affirm, Apple Pay, FSA/HSA, anything that reduces payment friction.
- CTA layout = 'single' (one CTA), 'multiple' (multiple primary CTAs visible), 'sticky_bottom' (bottom sticky CTA bar present), 'navigation_only' (no big CTA, just nav buttons).
- Visual style = one short phrase: "minimal modern", "aggressive promo", "trust-led medical", "story/VSL", etc.
- Observed patterns = 2-5 specific observations that could be conversion drivers (e.g. "countdown timer above the fold creates urgency", "quiz-first reduces commitment friction").

If you can't see something (e.g., text is cut off, page renders blank), say so explicitly in observed_patterns rather than fabricating.`;

const ANALYSIS_TOOL: Anthropic.Tool = {
  name: 'submit_lp_analysis',
  description: 'Emit the structured first-scroll analysis. Required fields must be filled.',
  input_schema: {
    type: 'object',
    properties: {
      hero_headline: { type: 'string' },
      subhead: { type: 'string' },
      primary_cta: {
        type: 'object',
        properties: {
          copy: { type: 'string' },
          position: { type: 'string', enum: ['top', 'middle', 'bottom'] },
          color_hint: { type: 'string' },
        },
        required: ['copy', 'position'],
      },
      secondary_cta: { type: 'string' },
      bullets: { type: 'array', items: { type: 'string' } },
      social_proof: { type: 'array', items: { type: 'string' } },
      badges: { type: 'array', items: { type: 'string' } },
      urgency_elements: { type: 'array', items: { type: 'string' } },
      pricing_visible: { type: 'string' },
      payment_options: { type: 'array', items: { type: 'string' } },
      cta_layout: { type: 'string', enum: ['single', 'multiple', 'sticky_bottom', 'navigation_only'] },
      visual_style: { type: 'string' },
      observed_patterns: { type: 'array', items: { type: 'string' } },
    },
    required: ['hero_headline', 'bullets', 'cta_layout', 'visual_style', 'observed_patterns'],
  },
};

export async function analyzeFirstScroll(
  capture: CaptureResult,
  url: string,
): Promise<{ analysis: FirstScrollAnalysis; input_tokens: number; output_tokens: number; raw: Anthropic.Message } | { error: string }> {
  const userBlocks: Anthropic.ContentBlockParam[] = [];
  if (capture.png_base64) {
    userBlocks.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: capture.png_base64 },
    });
  }
  const textBody = capture.png_base64
    ? `URL: ${url}\nThe attached image is the FIRST SCROLL of this landing page (mobile viewport 390x844). The text content of the page is below for cross-reference.\n\n--- Text content ---\n${capture.text_excerpt || '(empty)'}`
    : `URL: ${url}\n(No screenshot available — analyze from text only. Some visual elements like layout density and CTA color may be unknown.)\n\n--- Text content ---\n${capture.text_excerpt || '(empty)'}`;
  userBlocks.push({ type: 'text', text: textBody });

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1500,
    system: ANALYSIS_SYSTEM,
    thinking: { type: 'adaptive' },
    tools: [ANALYSIS_TOOL],
    tool_choice: { type: 'tool', name: 'submit_lp_analysis' },
    messages: [{ role: 'user', content: userBlocks }],
  });

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'submit_lp_analysis',
  );
  if (!toolUse) return { error: 'LLM did not call submit_lp_analysis tool' };
  const a = toolUse.input as unknown as FirstScrollAnalysis;
  return {
    analysis: a,
    input_tokens: response.usage?.input_tokens ?? 0,
    output_tokens: response.usage?.output_tokens ?? 0,
    raw: response,
  };
}

// ---------- Snapshot orchestration ----------

export async function snapshotCompetitor(
  competitor: Competitor,
  source: 'cron' | 'manual' | 'agent_tool' = 'cron',
): Promise<{ snapshot_id: number | null; analyzed: boolean; error: string | null }> {
  if (competitor.type !== 'landing_page') {
    return { snapshot_id: null, analyzed: false, error: `skipped — type=${competitor.type}` };
  }
  const cap = await captureUrl(competitor.url);
  if (!cap.png_base64 && !cap.text_excerpt) {
    return { snapshot_id: null, analyzed: false, error: cap.error ?? 'capture failed (no png, no text)' };
  }
  let parsed: FirstScrollAnalysis | null = null;
  let analysis_input_tokens: number | null = null;
  let analysis_output_tokens: number | null = null;
  let analysis_error: string | null = null;
  try {
    const a = await analyzeFirstScroll(cap, competitor.url);
    if ('error' in a) {
      analysis_error = a.error;
    } else {
      parsed = a.analysis;
      analysis_input_tokens = a.input_tokens;
      analysis_output_tokens = a.output_tokens;
    }
  } catch (err) {
    analysis_error = err instanceof Error ? err.message : String(err);
  }
  const { data, error } = await supabase
    .from('lp_snapshots')
    .insert({
      competitor_id: competitor.id,
      url: competitor.url,
      capture_source: source,
      screenshot_present: cap.png_base64 != null,
      screenshot_size_bytes: cap.png_size_bytes,
      rendered_html_excerpt: cap.rendered_html ? cap.rendered_html.slice(0, 16000) : null,
      raw_text_excerpt: cap.text_excerpt.slice(0, 16000),
      parsed_structure: parsed,
      analysis_model: parsed ? MODEL : null,
      analysis_input_tokens,
      analysis_output_tokens,
      analysis_error,
    })
    .select('id')
    .single();
  if (error || !data) {
    return { snapshot_id: null, analyzed: parsed != null, error: error?.message ?? 'insert failed' };
  }
  return { snapshot_id: data.id as number, analyzed: parsed != null, error: cap.error ?? analysis_error };
}

export interface DailyScrapeResult {
  total: number;
  succeeded: number;
  analyzed: number;
  failed: number;
  per_url: Array<{ url: string; ok: boolean; analyzed: boolean; error: string | null }>;
}

export async function runDailyScrape(): Promise<DailyScrapeResult> {
  const competitors = (await listCompetitors(false)).filter((c) => c.type === 'landing_page');
  const out: DailyScrapeResult = { total: competitors.length, succeeded: 0, analyzed: 0, failed: 0, per_url: [] };
  for (const c of competitors) {
    const r = await snapshotCompetitor(c, 'cron');
    const ok = r.snapshot_id != null;
    if (ok) out.succeeded++;
    else out.failed++;
    if (r.analyzed) out.analyzed++;
    out.per_url.push({ url: c.url, ok, analyzed: r.analyzed, error: r.error });
  }
  return out;
}

// ---------- Most-recent-per-competitor read ----------

export async function loadLatestSnapshots(): Promise<Array<SnapshotRow & { label: string | null }>> {
  const competitors = await listCompetitors(false);
  const out: Array<SnapshotRow & { label: string | null }> = [];
  for (const c of competitors) {
    const { data } = await supabase
      .from('lp_snapshots')
      .select('id, competitor_id, url, captured_at, parsed_structure, rendered_html_excerpt')
      .eq('competitor_id', c.id)
      .order('captured_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data) out.push({ ...(data as SnapshotRow), label: c.label });
  }
  return out;
}

// ---------- Recommendation engine ----------

const REC_SYSTEM = `You are Clayton, a senior CRO/media buyer for Claya (GLP-1 telehealth). You're looking at the FIRST SCROLL analyses of competitor landing pages alongside Claya's own funnel data, and producing a ranked list of testable recommendations the team should ship on claya.com.

Rules:
- Each recommendation is one specific change, not a vague theme. "Test 'Take the 30-second quiz' as the primary CTA" — not "improve the CTA".
- Cite specific competitor patterns by name as evidence. "TrimRX leads with a quiz; SHED uses 'Save $100 Today' as a single-CTA promo" — not "competitors do quizzes."
- Cite Claya funnel data when relevant. If you see a step with high drop-off, link the recommendation to that step.
- Implementation steps should be concrete enough that an engineer (Pack has code access) can ship from them.
- Expected lift band: low (5-15%), medium (15-30%), high (30%+). Be honest — most recommendations land in low or medium.
- Priority 1 = highest impact, lowest implementation cost. Priority N = nice-to-have.
- Produce 3-7 recommendations, ranked. Don't pad.

Submit via the submit_lp_recommendations tool.`;

const REC_TOOL: Anthropic.Tool = {
  name: 'submit_lp_recommendations',
  description: 'Emit the ranked recommendation list.',
  input_schema: {
    type: 'object',
    properties: {
      recommendations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            hypothesis: { type: 'string' },
            evidence: { type: 'array', items: { type: 'string' } },
            competitor_evidence: { type: 'array', items: { type: 'string' } },
            claya_data_evidence: { type: 'array', items: { type: 'string' } },
            implementation_steps: { type: 'array', items: { type: 'string' } },
            expected_lift_band: { type: 'string', enum: ['low', 'medium', 'high'] },
            expected_lift_pct: { type: 'number' },
            priority: { type: 'number' },
          },
          required: [
            'hypothesis',
            'evidence',
            'implementation_steps',
            'expected_lift_band',
            'priority',
          ],
        },
      },
      summary: { type: 'string' },
    },
    required: ['recommendations'],
  },
};

interface ClayaFunnelContext {
  cio_event_summary: string;
  meta_today_total_leads: number;
  meta_today_actions: Array<{ action_type: string; count: number }>;
}

async function gatherClayaFunnelContext(): Promise<ClayaFunnelContext> {
  let cio_event_summary = 'CIO not configured';
  if (CIO_CONFIGURED) {
    try {
      const events = await cioDiscoverEventNames(30, 5000);
      if (events.length === 0) cio_event_summary = 'CIO scanned — no events in last 30d (funnel currently dark)';
      else
        cio_event_summary =
          `CIO event volume (last 30d): ` +
          events
            .slice(0, 8)
            .map((e) => `${e.event_name}=${e.count}`)
            .join(', ');
    } catch (err) {
      cio_event_summary = `CIO scan failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  let meta_today_total_leads = 0;
  const meta_today_actions: Array<{ action_type: string; count: number }> = [];
  try {
    const todayInsights = await getCampaignInsights('today');
    for (const i of todayInsights) {
      meta_today_total_leads += extractLeads(i);
    }
    const breakdown = await getActionBreakdown(null, 'campaign', 'last_7d');
    const tally = new Map<string, number>();
    for (const row of breakdown) {
      for (const a of row.actions ?? []) {
        const t = (a.action_type ?? '').toLowerCase();
        tally.set(t, (tally.get(t) ?? 0) + Number(a.value ?? 0));
      }
    }
    for (const [k, v] of tally) meta_today_actions.push({ action_type: k, count: v });
    meta_today_actions.sort((a, b) => b.count - a.count);
  } catch (err) {
    console.warn('[LP] gatherClayaFunnelContext meta side failed:', err);
  }
  return { cio_event_summary, meta_today_total_leads, meta_today_actions: meta_today_actions.slice(0, 10) };
}

function summarizeAnalyses(snaps: Array<SnapshotRow & { label: string | null }>): string {
  const lines: string[] = [];
  for (const s of snaps) {
    const a = s.parsed_structure;
    if (!a) {
      lines.push(`- ${s.label ?? s.url}: (analysis unavailable)`);
      continue;
    }
    const cta = a.primary_cta ? `"${a.primary_cta.copy}" (${a.primary_cta.position}${a.primary_cta.color_hint ? ', ' + a.primary_cta.color_hint : ''})` : '(none seen)';
    lines.push(`- ${s.label ?? s.url}`);
    lines.push(`    headline: "${a.hero_headline ?? '?'}"`);
    if (a.subhead) lines.push(`    subhead: "${a.subhead}"`);
    lines.push(`    primary CTA: ${cta}`);
    lines.push(`    pricing visible: ${a.pricing_visible ?? 'no'}`);
    lines.push(`    bullets (${a.bullets.length}): ${a.bullets.slice(0, 4).join(' | ')}`);
    if (a.social_proof.length > 0) lines.push(`    social proof: ${a.social_proof.slice(0, 3).join(' | ')}`);
    if (a.badges.length > 0) lines.push(`    badges: ${a.badges.join(', ')}`);
    if (a.urgency_elements.length > 0) lines.push(`    urgency: ${a.urgency_elements.join(' | ')}`);
    if (a.payment_options.length > 0) lines.push(`    payment options: ${a.payment_options.join(', ')}`);
    lines.push(`    cta_layout: ${a.cta_layout} | visual_style: ${a.visual_style}`);
    if (a.observed_patterns.length > 0) lines.push(`    patterns: ${a.observed_patterns.slice(0, 3).join(' | ')}`);
  }
  return lines.join('\n');
}

export async function generateRecommendations(): Promise<{
  recommendations: LpRecommendation[];
  summary: string;
  saved_ids: number[];
  input_tokens: number;
  output_tokens: number;
} | { error: string }> {
  const snaps = await loadLatestSnapshots();
  const usable = snaps.filter((s) => s.parsed_structure != null);
  if (usable.length === 0) {
    return { error: 'No analyzed snapshots yet — run /lp scan first.' };
  }
  const claya = await gatherClayaFunnelContext();
  const competitorBlock = summarizeAnalyses(snaps);

  const prompt = [
    `# Competitor first-scroll analyses (most recent per URL)`,
    competitorBlock,
    '',
    `# Claya funnel signal`,
    `CIO: ${claya.cio_event_summary}`,
    `Meta total leads today: ${claya.meta_today_total_leads}`,
    `Meta last_7d action types (top 10):`,
    ...claya.meta_today_actions.map((a) => `  ${a.action_type}: ${a.count}`),
    '',
    `# Claya page (claya.com) — what we know`,
    `Headline: "Finally serious about weight loss? So are we. Fat loss made easy with personalized care and GLP-1 medication"`,
    `Primary CTA: "Am I Qualified?" (qualification framing)`,
    `Bullets: 5 (lose pounds weekly, money-back, no membership, $179 no-insurance, HSA/FSA)`,
    `Trust stack: Trustpilot, BBB, HIPAA, LegitScript`,
    `Pricing visible: $179 in bullet 4`,
    '',
    `Produce 3-7 ranked recommendations Claya should test next, grounded in the competitor patterns and the Claya signal above.`,
  ].join('\n');

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2500,
    system: REC_SYSTEM,
    thinking: { type: 'adaptive' },
    tools: [REC_TOOL],
    tool_choice: { type: 'tool', name: 'submit_lp_recommendations' },
    messages: [{ role: 'user', content: prompt }],
  });

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'submit_lp_recommendations',
  );
  if (!toolUse) return { error: 'LLM did not call submit_lp_recommendations tool' };
  const out = toolUse.input as unknown as { recommendations: LpRecommendation[]; summary?: string };

  const saved_ids: number[] = [];
  for (const rec of out.recommendations ?? []) {
    const { data, error } = await supabase
      .from('lp_recommendations')
      .insert({
        hypothesis: rec.hypothesis,
        evidence: rec.evidence ?? [],
        competitor_evidence: rec.competitor_evidence ?? [],
        claya_data_evidence: rec.claya_data_evidence ?? [],
        implementation_steps: rec.implementation_steps ?? [],
        expected_lift_band: rec.expected_lift_band,
        expected_lift_pct: rec.expected_lift_pct ?? null,
        priority: rec.priority ?? 99,
        status: 'proposed',
      })
      .select('id')
      .single();
    if (!error && data) saved_ids.push(data.id as number);
  }
  return {
    recommendations: out.recommendations ?? [],
    summary: out.summary ?? '',
    saved_ids,
    input_tokens: response.usage?.input_tokens ?? 0,
    output_tokens: response.usage?.output_tokens ?? 0,
  };
}

// ---------- Recommendation read/track ----------

export async function listRecommendations(
  status: 'proposed' | 'sent' | 'implemented' | 'measured' | 'rejected' | 'all' = 'proposed',
  limit = 30,
): Promise<LpRecommendation[]> {
  let q = supabase.from('lp_recommendations').select('*').order('priority', { ascending: true }).order('created_at', { ascending: false }).limit(limit);
  if (status !== 'all') q = q.eq('status', status);
  const { data, error } = await q;
  if (error) {
    console.error('[LP] listRecommendations failed:', error.message);
    return [];
  }
  return (data ?? []) as LpRecommendation[];
}

export async function markRecommendationStatus(
  id: number,
  status: 'sent' | 'implemented' | 'rejected' | 'measured',
  deployDate?: string,
): Promise<void> {
  const patch: Record<string, unknown> = { status };
  if (deployDate) patch.deploy_date = deployDate;
  const { error } = await supabase.from('lp_recommendations').update(patch).eq('id', id);
  if (error) throw new Error(`markRecommendationStatus: ${error.message}`);
}

// ---------- Telegram formatting ----------

export function formatRecommendationsForTelegram(recs: LpRecommendation[], summary?: string): string {
  if (recs.length === 0) return 'No recommendations available.';
  const lines: string[] = [];
  if (summary) {
    lines.push(summary);
    lines.push('');
  }
  for (const r of recs) {
    lines.push(`#${r.id ?? '?'} (P${r.priority}, ${r.expected_lift_band} lift${r.expected_lift_pct ? ` ~${r.expected_lift_pct}%` : ''})`);
    lines.push(`  Hypothesis: ${r.hypothesis}`);
    if (r.competitor_evidence?.length) {
      lines.push(`  Competitor evidence:`);
      for (const e of r.competitor_evidence.slice(0, 3)) lines.push(`    • ${e}`);
    }
    if (r.claya_data_evidence?.length) {
      lines.push(`  Claya signal:`);
      for (const e of r.claya_data_evidence.slice(0, 3)) lines.push(`    • ${e}`);
    }
    if (r.implementation_steps?.length) {
      lines.push(`  Implementation:`);
      for (const s of r.implementation_steps.slice(0, 4)) lines.push(`    • ${s}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ---------- Recipient discovery for cron notify ----------

async function loadRecipientChatIds(): Promise<string[]> {
  const env = (process.env.BRIEFING_CHAT_IDS ?? '').trim();
  if (env) return env.split(',').map((s) => s.trim()).filter(Boolean);
  const { data } = await supabase
    .from('chat_messages')
    .select('chat_id')
    .order('created_at', { ascending: false })
    .limit(500);
  if (!data) return [];
  return [...new Set(data.map((r) => String(r.chat_id)))];
}

async function notifyTelegram(text: string): Promise<void> {
  const recipients = await loadRecipientChatIds();
  for (const cid of recipients) {
    try {
      await bot.sendMessage(cid, text);
    } catch (err) {
      console.error('[LP] telegram send failed:', err);
    }
  }
}

// ---------- Cron entry point ----------

export async function runDailyLpTick(): Promise<DailyScrapeResult> {
  const r = await runDailyScrape();
  const lines: string[] = [
    `LP scrape: ${r.succeeded}/${r.total} succeeded, ${r.analyzed} analyzed, ${r.failed} failed.`,
  ];
  for (const u of r.per_url) {
    if (!u.ok || !u.analyzed) {
      lines.push(`  ${u.url}: ${u.ok ? 'no analysis' : 'capture failed'}${u.error ? ` — ${u.error.slice(0, 120)}` : ''}`);
    }
  }
  if (lines.length > 1) {
    await notifyTelegram(lines.join('\n'));
  }
  return r;
}

// CLI: `tsx agents/lp.ts scan` runs one daily tick.
import { fileURLToPath } from 'node:url';
const isCli = process.argv[1] === fileURLToPath(import.meta.url);
if (isCli) {
  const cmd = process.argv[2];
  if (cmd === 'scan') {
    runDailyLpTick()
      .then((r) => {
        console.log(JSON.stringify(r, null, 2));
        process.exit(0);
      })
      .catch((err) => {
        console.error(err);
        process.exit(1);
      });
  } else if (cmd === 'recommend') {
    generateRecommendations()
      .then((r) => {
        console.log(JSON.stringify(r, null, 2));
        process.exit(0);
      })
      .catch((err) => {
        console.error(err);
        process.exit(1);
      });
  } else {
    console.error('Usage: tsx agents/lp.ts <scan|recommend>');
    process.exit(1);
  }
}
