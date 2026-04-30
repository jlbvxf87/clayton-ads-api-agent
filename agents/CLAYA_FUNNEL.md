# Claya Funnel Analysis — synthetic walkthrough (test lead: `londalechilds@gmail.com`)

> **Note:** This was a test walkthrough Pack performed using synthetic data (DOB, address, phone all fake) to map the funnel structure end-to-end. Not a real customer record. The structure is real; the lead identity is not.

---

## Step 0: Homepage (claya.com)

- Entry: hero promoting GLP-1 weight loss medication
- Headline: "Begin your weight loss journey with Claya."
- Value props: Get Approved → Get Prescribed → Get Delivered
- CTA: "Get Started" → intake form

---

## Phase 1: Start — BMI & body goals
URL: `join.claya.com/intake-form`. Five-step progress bar: Start → Preliminary → Health → Details → Eligibility.

| # | Question | Test response |
|---|---|---|
| 1 | Height & weight | 5'10", 210 lbs |
| 2 | BMI | 30.13 — "Perfect! We can continue." |
| 3 | Goal weight | 185 lbs |
| 4 | Gender | Male |

## Phase 2: Preliminary — profile & motivation

| # | Question | Test response |
|---|---|---|
| 5 | Weight-related symptoms | None |
| 6 | Primary goal | Lose Weight |
| 7 | Social proof | Forbes Health #1 Pick, 9.7/10 |
| 8 | Science | "With Claya vs Without" 12-month curve |
| 9 | Testimonial | Tania -20 lbs (before/after) |
| 10 | GLP-1 timeline | Wk 1-4 acclimation → 4-8 increasing → 9+ fat-burning |
| 11 | Primary motivation | All of these (longer life / look better / health) |

## Phase 3: Health — medical screening

| # | Question | Test response |
|---|---|---|
| 12 | Personalized pace | "3.75-5 lbs/week — ~7 weeks" |
| 13 | Encouragement | "Losing 25 lbs is easier than you think" |
| 14 | Sleep quality | Pretty Good |
| 15 | Sleep hours | 8-9 |
| 16 | Testimonial | Kristin -29 lbs |
| 17 | Disqualifying conditions | None |
| 18 | Other conditions | None |
| 19 | Prior GLP-1 use | Not currently taking |
| 20 | Opiate use | No |
| 21 | Prior weight surgery | No |
| 22 | Prior weight programs | No |

## Phase 4: Details — lifestyle & preferences

| # | Question | Test response |
|---|---|---|
| 23 | Willingness to change | Reduce calories + increase activity |
| 24 | Weight change last year | Gained a little |
| 25 | Testimonial | Daiene -90 lbs |
| 26 | Blood pressure | <120/80 |
| 27 | Resting heart rate | 60-100 bpm |
| 28 | Medication preference | Affordability |
| 29 | Current medications | No |
| 30 | Mindset | "I'm Ready!" |
| 31 | Additional info | No |
| 32 | Customization interests | Maintain muscle + improve energy |

## Phase 5: Eligibility — identity & contact

| # | Question | Test response |
|---|---|---|
| 33 | DOB | 1985-01-15 |
| 34 | Medical summary | BMI 30.13, 210→185 in ~6.67 wk. **94% treatment success probability.** |
| 35 | Name + state | Londale Childs — Texas |
| 36 | **Email + phone + HIPAA** | `londalechilds@gmail.com`, (555) 123-4567 |
| 37 | Shipping address | 123 Main St, Houston, TX |

## Phase 6: Checkout — pricing & plan selection
URL: `join.claya.com/checkout`.

**Urgency mechanisms:**
- Countdown timer: "Only 32 discounts left — yours is reserved for: 14:48"
- "First shipment $120 OFF" banner

**Treatment options:**
| Option | Label | Live count signal |
|---|---|---|
| Semaglutide | Most Affordable | 11,867 patients today |
| Tirzepatide | Fastest Results | 18,119 patients today |

**Plans (Semaglutide):**
| Plan | Supply | Price | Savings |
|---|---|---|---|
| 1-Month | 4 wk | $179 | $120 off |
| 3-Month ⭐ Most Popular | 12 wk | $219/mo | $240 off |
| 6-Month | 24 wk | $189/mo | $660 off |
| 12-Month 🏆 Best Deal | 48 wk | $149/mo | $1,800 off |

**All plans include:** free dose increases, treatment changes anytime, unlimited free doctor consults, free expedited shipping, home injection kit, 24/7 support.

---

## Funnel observations

| | |
|---|---|
| Length | ~37 screens homepage → checkout |
| Social proof | Forbes #1, Trustpilot Excellent, 100K+ customers, before/after, named testimonials |
| Personalization | Real-time BMI, goal weight, pace, "94% success" |
| Medical framing | HIPAA, real clinical screening |
| Urgency | Countdown + limited-discount mechanic at checkout |
| Email gate | Screen 36 of 37 — captured very late, maximizes completion before data ask |
| Checkout friction | Low — no password, no card before pricing |
