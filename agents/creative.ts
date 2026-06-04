import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { supabase } from './supabase.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ---------- Types ----------

export type HookType =
  | 'authority'
  | 'fear'
  | 'transformation'
  | 'social_proof'
  | 'curiosity'
  | 'urgency'
  | 'aspiration'
  | 'education'
  | 'ugc_personal';

export type EmotionalAngle =
  | 'fear_of_obesity'
  | 'longevity'
  | 'confidence'
  | 'energy'
  | 'medical_authority'
  | 'fast_transformation'
  | 'luxury_wellness'
  | 'motherhood'
  | 'self_improvement'
  | 'clinical_proof';

export type CreativeFormat =
  | 'ugc_video'
  | 'static_image'
  | 'carousel'
  | 'slideshow'
  | 'text_only';

export type ClaimType =
  | 'clinical'
  | 'testimonial'
  | 'statistical'
  | 'lifestyle'
  | 'authority'
  | 'comparative';

export interface CreativeTag {
  ad_id: string;
  ad_name: string;
  hook_type: HookType;
  emotional_angle: EmotionalAngle;
  format: CreativeFormat;
  creator_led: boolean;
  claim_type: ClaimType;
  cta_language: string | null;
  hook_text: string | null;
  notes: string | null;
  tagged_by: 'auto' | 'manual';
  confidence: number;
}

// ---------- Auto-tagger ----------

const TAG_TOOL: Anthropic.Tool = {
  name: 'submit_creative_tag',
  description: 'Submit structured tags for a Meta ad creative.',
  input_schema: {
    type: 'object' as const,
    properties: {
      hook_type: {
        type: 'string',
        enum: ['authority', 'fear', 'transformation', 'social_proof', 'curiosity', 'urgency', 'aspiration', 'education', 'ugc_personal'],
      },
      emotional_angle: {
        type: 'string',
        enum: ['fear_of_obesity', 'longevity', 'confidence', 'energy', 'medical_authority', 'fast_transformation', 'luxury_wellness', 'motherhood', 'self_improvement', 'clinical_proof'],
      },
      format: {
        type: 'string',
        enum: ['ugc_video', 'static_image', 'carousel', 'slideshow', 'text_only'],
      },
      creator_led: { type: 'boolean' },
      claim_type: {
        type: 'string',
        enum: ['clinical', 'testimonial', 'statistical', 'lifestyle', 'authority', 'comparative'],
      },
      cta_language: { type: 'string' },
      hook_text: { type: 'string', description: 'The opening line or hook of the ad copy.' },
      notes: { type: 'string', description: 'Any notable observations about this creative.' },
      confidence: { type: 'number', description: '0.0–1.0 confidence in these tags.' },
    },
    required: ['hook_type', 'emotional_angle', 'format', 'creator_led', 'claim_type', 'confidence'],
  },
};

const TAGGER_SYSTEM = `You are a direct response creative analyst specializing in healthcare telehealth ads, specifically GLP-1 weight loss and TRT brands.

The brand is Claya — a telehealth clinic selling GLP-1 medications (semaglutide, tirzepatide) and TRT.

Tag the ad based on:
- Ad name patterns: names like "Corrine", "Maddy", "CorrineWeek2", "MaddyDay", "Week2", "Day30" = ugc_video + creator_led=true
- Doctor/medical framing = medical_authority angle + authority hook
- Before/after, transformation stories = transformation hook + fast_transformation angle
- Scary stats or consequences = fear hook + fear_of_obesity angle
- "Learn more", "Get started", "See if you qualify" = common CTA patterns
- Social proof (reviews, testimonials) = social_proof hook

Be decisive. If uncertain between two tags, pick the dominant one.`;

export async function autoTagAd(ad: {
  id: string;
  name: string;
  title?: string;
  body?: string;
  campaign_id?: string;
  campaign_name?: string;
}): Promise<CreativeTag> {
  const userContent = `Tag this ad creative:

Ad name: ${ad.name}
${ad.title ? `Title: ${ad.title}` : ''}
${ad.body ? `Body: ${ad.body}` : ''}
${ad.campaign_name ? `Campaign: ${ad.campaign_name}` : ''}`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    system: TAGGER_SYSTEM,
    tools: [TAG_TOOL],
    tool_choice: { type: 'any' },
    messages: [{ role: 'user', content: userContent }],
  });

  const toolBlock = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'submit_creative_tag',
  );

  if (!toolBlock) {
    // Fallback with low confidence if model didn't call the tool
    return {
      ad_id: ad.id,
      ad_name: ad.name,
      hook_type: 'ugc_personal',
      emotional_angle: 'self_improvement',
      format: ad.name.match(/week|day|corrine|maddy/i) ? 'ugc_video' : 'static_image',
      creator_led: Boolean(ad.name.match(/week|day|corrine|maddy/i)),
      claim_type: 'testimonial',
      cta_language: null,
      hook_text: null,
      notes: 'Auto-tag fallback — model did not call tool',
      tagged_by: 'auto',
      confidence: 0.3,
    };
  }

  const input = toolBlock.input as Record<string, unknown>;
  return {
    ad_id: ad.id,
    ad_name: ad.name,
    hook_type: input.hook_type as HookType,
    emotional_angle: input.emotional_angle as EmotionalAngle,
    format: input.format as CreativeFormat,
    creator_led: Boolean(input.creator_led),
    claim_type: input.claim_type as ClaimType,
    cta_language: (input.cta_language as string | null) ?? null,
    hook_text: (input.hook_text as string | null) ?? null,
    notes: (input.notes as string | null) ?? null,
    tagged_by: 'auto',
    confidence: Math.min(1, Math.max(0, Number(input.confidence) || 0.8)),
  };
}

// ---------- Persistence ----------

export async function saveCreativeTag(
  tag: CreativeTag & { campaign_id?: string; campaign_name?: string },
): Promise<void> {
  const { error } = await supabase.from('ad_creative_tags').upsert(
    {
      ad_id: tag.ad_id,
      ad_name: tag.ad_name,
      campaign_id: tag.campaign_id ?? null,
      campaign_name: tag.campaign_name ?? null,
      hook_type: tag.hook_type,
      emotional_angle: tag.emotional_angle,
      format: tag.format,
      creator_led: tag.creator_led,
      claim_type: tag.claim_type,
      cta_language: tag.cta_language,
      hook_text: tag.hook_text,
      notes: tag.notes,
      tagged_by: tag.tagged_by,
      confidence: tag.confidence,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'ad_id' },
  );
  if (error) throw new Error(`saveCreativeTag failed: ${error.message}`);
}

export async function getCreativeTag(adId: string): Promise<CreativeTag | null> {
  const { data, error } = await supabase
    .from('ad_creative_tags')
    .select('*')
    .eq('ad_id', adId)
    .maybeSingle();
  if (error) throw new Error(`getCreativeTag failed: ${error.message}`);
  return data as CreativeTag | null;
}

export async function listCreativeTags(opts?: {
  campaign_id?: string;
  hook_type?: HookType;
  emotional_angle?: EmotionalAngle;
  limit?: number;
}): Promise<(CreativeTag & { id: number; created_at: string })[]> {
  let q = supabase.from('ad_creative_tags').select('*').order('created_at', { ascending: false });
  if (opts?.campaign_id) q = q.eq('campaign_id', opts.campaign_id);
  if (opts?.hook_type) q = q.eq('hook_type', opts.hook_type);
  if (opts?.emotional_angle) q = q.eq('emotional_angle', opts.emotional_angle);
  q = q.limit(opts?.limit ?? 100);
  const { data, error } = await q;
  if (error) throw new Error(`listCreativeTags failed: ${error.message}`);
  return (data ?? []) as (CreativeTag & { id: number; created_at: string })[];
}

export async function tagAndSaveAd(ad: {
  id: string;
  name: string;
  title?: string;
  body?: string;
  campaign_id?: string;
  campaign_name?: string;
}): Promise<CreativeTag> {
  const tag = await autoTagAd(ad);
  await saveCreativeTag({ ...tag, campaign_id: ad.campaign_id, campaign_name: ad.campaign_name });
  return tag;
}

// ---------- Formatting ----------

export function formatTagSummary(tag: CreativeTag): string {
  const parts = [
    tag.hook_type.replace(/_/g, ' '),
    tag.emotional_angle.replace(/_/g, ' '),
    tag.format.replace(/_/g, ' '),
    tag.creator_led ? 'creator-led' : 'brand',
    tag.claim_type,
  ];
  const conf = tag.confidence < 0.6 ? ` (low confidence)` : '';
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' · ') + conf;
}

// ---------- Policy audit (pre-launch vision check) ----------

export interface PolicyAuditResult {
  ad_id: string;
  ad_name?: string;
  passes_policy: 'PASS' | 'AT_RISK' | 'WILL_REJECT';
  confidence: number;                // 0.0–1.0
  risks_detected: string[];          // specific findings
  recommended_fixes: string[];       // actionable rewrites/replacements
  image_observations: string;        // what's actually in the image
  text_observations: string;         // overlay text + body copy
}

const AUDIT_TOOL: Anthropic.Tool = {
  name: 'submit_policy_audit',
  description: 'Submit a structured Meta ad policy audit for this creative.',
  input_schema: {
    type: 'object' as const,
    properties: {
      passes_policy: { type: 'string', enum: ['PASS', 'AT_RISK', 'WILL_REJECT'] },
      confidence: { type: 'number', description: '0.0–1.0' },
      image_observations: { type: 'string', description: '1-3 sentences describing literally what is in the image: subject, layout, key visual elements.' },
      text_observations: { type: 'string', description: 'Transcribe any text overlay on the image + summarize the ad body copy.' },
      risks_detected: {
        type: 'array',
        items: { type: 'string' },
        description: 'Specific Meta policy triggers found. Each item should be concrete: "Image shows 2 unlabeled glass vials with rubber stoppers" not "has medical imagery".',
      },
      recommended_fixes: {
        type: 'array',
        items: { type: 'string' },
        description: 'Actionable rewrites — what to change to make this creative pass review. One per risk.',
      },
    },
    required: ['passes_policy', 'confidence', 'image_observations', 'text_observations', 'risks_detected', 'recommended_fixes'],
  },
};

const AUDITOR_SYSTEM = `You are a Meta ad policy expert specializing in health / weight-loss / GLP-1 telehealth ads for the brand Claya.

You're auditing ONE ad creative BEFORE launch (or post-rejection to learn) to flag specific policy triggers Meta's automated review will catch.

Meta's "Drugs and Pharmaceutical Products" category auto-rejects creatives that contain:

VISUAL TRIGGERS (image-side, caught by OCR + vision):
- Unlabeled or branded medication vials, syringes, needles, pill bottles, blister packs
- Injection equipment of any kind
- Before/after weight loss composites or arrows pointing to body parts
- Scale photos with weight numbers visible
- Body-shaming framing (zoomed shots of stomachs, etc.)

TEXT TRIGGERS (in image overlays AND in ad copy):
- Brand drug names: Ozempic, Wegovy, Mounjaro, Zepbound, Saxenda, Rybelsus
- Generic drug names in promo context: "semaglutide", "tirzepatide" (use "GLP-1" or "weight loss medication" instead)
- Specific weight-loss numbers: "Lost 30 lbs in 30 days", "Down 22 pounds"
- Unrealistic-result claims: "guaranteed", "miracle", "cure", "instant"
- Personal attribute violations: "Are YOU overweight?" / "Tired of being fat?" (Meta infers you know personal info about the viewer)
- Body-shaming or before-state negativity

WHAT PASSES:
- Lifestyle-framed imagery (people doing things, not posing for weight comparison)
- Process framing: "See if you qualify", "3-minute screening", "Doctor-reviewed"
- "If you've" empathy openers: "If you've tried every diet…" (scenario-based, not personal-attribute)
- Authority framing without specific drug names: "Doctor-prescribed weight loss"
- Generic GLP-1 / "weight loss medication" language

Be SPECIFIC. "Has medical imagery" is too vague. "Image shows 2 clear glass vials with blue rubber stoppers, partially behind a hand" is right.

Be DECISIVE. If you see a vial OR a brand drug name, verdict = WILL_REJECT (confidence ≥ 0.85). If borderline (e.g. white pill bottle without label, generic medical pen), verdict = AT_RISK (confidence 0.5–0.7). Only PASS if there's nothing on either the visual OR text trigger lists.`;

export async function auditCreative(ad: {
  id: string;
  name?: string;
  image_url?: string;
  body?: string;
  title?: string;
}): Promise<PolicyAuditResult> {
  const userText = `Audit this Claya ad creative:

Ad ID: ${ad.id}
Ad name: ${ad.name ?? '(unnamed)'}
Body copy: ${ad.body ?? '(none — likely text in image overlay)'}
Title/Headline: ${ad.title ?? '(none)'}
Image: ${ad.image_url ? 'attached below' : '(none — cannot vision-audit)'}

Run the audit. Call submit_policy_audit with your findings.`;

  const content: Anthropic.ContentBlockParam[] = [{ type: 'text', text: userText }];

  // Attach image as base64 if available
  if (ad.image_url) {
    try {
      const axios = (await import('axios')).default;
      const resp = await axios.get(ad.image_url, { responseType: 'arraybuffer', timeout: 15000 });
      const b64 = Buffer.from(resp.data).toString('base64');
      const ct = (resp.headers['content-type'] as string | undefined) ?? 'image/jpeg';
      const media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' =
        ct.includes('png') ? 'image/png' : ct.includes('gif') ? 'image/gif' : ct.includes('webp') ? 'image/webp' : 'image/jpeg';
      content.push({ type: 'image', source: { type: 'base64', media_type, data: b64 } });
    } catch (err) {
      // Image fetch failed — fall through to text-only audit
    }
  }

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: AUDITOR_SYSTEM,
    tools: [AUDIT_TOOL],
    tool_choice: { type: 'any' },
    messages: [{ role: 'user', content }],
  });

  const toolBlock = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'submit_policy_audit',
  );
  if (!toolBlock) {
    return {
      ad_id: ad.id,
      ad_name: ad.name,
      passes_policy: 'AT_RISK',
      confidence: 0.3,
      risks_detected: ['Auditor did not call tool — manual review required'],
      recommended_fixes: [],
      image_observations: '(audit failed)',
      text_observations: '(audit failed)',
    };
  }
  const i = toolBlock.input as Record<string, unknown>;
  return {
    ad_id: ad.id,
    ad_name: ad.name,
    passes_policy: i.passes_policy as PolicyAuditResult['passes_policy'],
    confidence: Math.min(1, Math.max(0, Number(i.confidence) || 0.5)),
    image_observations: (i.image_observations as string) ?? '',
    text_observations: (i.text_observations as string) ?? '',
    risks_detected: Array.isArray(i.risks_detected) ? (i.risks_detected as string[]) : [],
    recommended_fixes: Array.isArray(i.recommended_fixes) ? (i.recommended_fixes as string[]) : [],
  };
}

export function formatPolicyAudit(r: PolicyAuditResult): string {
  const verdictEmoji = r.passes_policy === 'PASS' ? '✓' : r.passes_policy === 'AT_RISK' ? '⚠' : '✗';
  const lines: string[] = [
    `${verdictEmoji} ${r.passes_policy} (confidence ${(r.confidence * 100).toFixed(0)}%) — ${r.ad_name ?? r.ad_id}`,
    '',
    `Image: ${r.image_observations}`,
    `Text:  ${r.text_observations}`,
  ];
  if (r.risks_detected.length > 0) {
    lines.push('', 'Risks:');
    for (const x of r.risks_detected) lines.push(`  • ${x}`);
  }
  if (r.recommended_fixes.length > 0) {
    lines.push('', 'Fixes:');
    for (const x of r.recommended_fixes) lines.push(`  → ${x}`);
  }
  return lines.join('\n');
}

// ---------- Performance by angle ----------

export async function getCreativePerformanceByAngle(): Promise<
  { angle: EmotionalAngle; avg_cpl: number | null; ad_count: number }[]
> {
  try {
    const { data, error } = await supabase
      .from('ad_creative_tags')
      .select('emotional_angle, ad_id');
    if (error || !data) return [];

    // Group by angle — CPL joins would require campaign_snapshots correlation,
    // which needs spend + leads joined by campaign_id. Return counts for now;
    // CPL enrichment is Phase 2 once memory layer is wired.
    const byAngle = new Map<EmotionalAngle, number>();
    for (const row of data) {
      const angle = row.emotional_angle as EmotionalAngle;
      byAngle.set(angle, (byAngle.get(angle) ?? 0) + 1);
    }
    return [...byAngle.entries()].map(([angle, ad_count]) => ({
      angle,
      avg_cpl: null, // Phase 2: join with campaign_snapshots
      ad_count,
    })).sort((a, b) => b.ad_count - a.ad_count);
  } catch {
    return [];
  }
}
