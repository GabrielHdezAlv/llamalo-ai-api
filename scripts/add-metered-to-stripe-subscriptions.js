#!/usr/bin/env node
/**
 * Añade el precio metered (minutos extra) a suscripciones Stripe existentes que solo
 * tienen el plan fijo. Usa las mismas variables que el API (STRIPE_PRICE_*_METERED, etc.).
 *
 * Requisitos en el entorno:
 *   STRIPE_SECRET_KEY
 *   STRIPE_PRICE_{STARTER,GROWTH,SCALE} y _ANNUAL
 *   STRIPE_PRICE_{STARTER,GROWTH,SCALE}_METERED y _METERED_ANNUAL
 *
 * Uso (desde la raíz de llamalo-ai-api):
 *   node scripts/add-metered-to-stripe-subscriptions.js --dry-run
 *   node scripts/add-metered-to-stripe-subscriptions.js
 *
 * Opcional:
 *   --user-id UID  (solo ese usuario en Firestore)
 *   --verify        solo comprueba en Stripe/Firestore (correo + estado metered), no modifica nada
 */

const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const Stripe = require('stripe');

const PAID_PLANS = new Set(['starter', 'growth', 'scale']);

/** Carga `.env` en la raíz del proyecto si existe (no sobrescribe variables ya definidas). */
function loadEnvFromDotenv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

function loadServiceAccount() {
  const renderPath = '/etc/secrets/firebase_service_account.json';
  const localPath = path.join(
    __dirname,
    '..',
    'src',
    'config',
    'firebase-service-account.json',
  );
  if (fs.existsSync(renderPath)) {
    return JSON.parse(fs.readFileSync(renderPath, 'utf8'));
  }
  if (fs.existsSync(localPath)) {
    return JSON.parse(fs.readFileSync(localPath, 'utf8'));
  }
  throw new Error(
    'No se encontró el JSON de cuenta de servicio Firebase (src/config/firebase-service-account.json).',
  );
}

function trimEnv(key) {
  const v = process.env[key];
  return typeof v === 'string' ? v.trim() : '';
}

function buildBasePriceRows() {
  const rows = [
    { id: trimEnv('STRIPE_PRICE_STARTER'), plan: 'starter', interval: 'month' },
    { id: trimEnv('STRIPE_PRICE_GROWTH'), plan: 'growth', interval: 'month' },
    { id: trimEnv('STRIPE_PRICE_SCALE'), plan: 'scale', interval: 'month' },
    {
      id: trimEnv('STRIPE_PRICE_STARTER_ANNUAL'),
      plan: 'starter',
      interval: 'year',
    },
    {
      id: trimEnv('STRIPE_PRICE_GROWTH_ANNUAL'),
      plan: 'growth',
      interval: 'year',
    },
    {
      id: trimEnv('STRIPE_PRICE_SCALE_ANNUAL'),
      plan: 'scale',
      interval: 'year',
    },
  ];
  return rows.filter((r) => r.id);
}

function buildMeteredPriceSet() {
  const ids = [
    trimEnv('STRIPE_PRICE_STARTER_METERED'),
    trimEnv('STRIPE_PRICE_GROWTH_METERED'),
    trimEnv('STRIPE_PRICE_SCALE_METERED'),
    trimEnv('STRIPE_PRICE_STARTER_METERED_ANNUAL'),
    trimEnv('STRIPE_PRICE_GROWTH_METERED_ANNUAL'),
    trimEnv('STRIPE_PRICE_SCALE_METERED_ANNUAL'),
  ].filter(Boolean);
  return new Set(ids);
}

function meteredPriceForPlan(plan, interval) {
  const monthly = {
    starter: trimEnv('STRIPE_PRICE_STARTER_METERED'),
    growth: trimEnv('STRIPE_PRICE_GROWTH_METERED'),
    scale: trimEnv('STRIPE_PRICE_SCALE_METERED'),
  };
  const annual = {
    starter: trimEnv('STRIPE_PRICE_STARTER_METERED_ANNUAL'),
    growth: trimEnv('STRIPE_PRICE_GROWTH_METERED_ANNUAL'),
    scale: trimEnv('STRIPE_PRICE_SCALE_METERED_ANNUAL'),
  };
  const table = interval === 'year' ? annual : monthly;
  return table[plan] || '';
}

function detectPlanAndIntervalFromItems(subscription, baseRows) {
  const items = subscription.items?.data || [];
  const byPriceId = new Map(baseRows.map((r) => [r.id, r]));

  for (const item of items) {
    const pid = item.price?.id;
    if (!pid) continue;
    const hit = byPriceId.get(pid);
    if (hit) return { plan: hit.plan, interval: hit.interval };
  }

  /** Fallback: intervalo desde el primer ítem con precio recurrente no metered */
  for (const item of items) {
    const price = item.price;
    if (!price?.recurring) continue;
    if (price.recurring.usage_type === 'metered') continue;
    const interval = price.recurring.interval === 'year' ? 'year' : 'month';
    return { plan: null, interval };
  }
  return null;
}

function planFromFirestore(planRaw) {
  if (!planRaw || typeof planRaw !== 'string') return null;
  const p = planRaw.trim();
  return PAID_PLANS.has(p) ? p : null;
}

function userEmail(data) {
  const e = data?.email;
  if (typeof e === 'string' && e.trim()) return e.trim();
  return '(sin email)';
}

function subscriptionHasMetered(items, meteredSet) {
  for (const item of items) {
    const pid = item.price?.id;
    if (pid && meteredSet.has(pid)) return true;
    if (item.price?.recurring?.usage_type === 'metered') return true;
  }
  return false;
}

/**
 * Lista todos los usuarios: correo, uid, si la suscripción en Stripe tiene metered, incoherencias.
 * No escribe en Stripe ni en Firestore.
 */
async function runVerifyOnly(stripe, db, meteredSet) {
  console.log(
    '--- Modo --verify: comprobación (solo lectura Stripe + Firestore) ---\n',
  );
  const docs = (await db.collection('users').get()).docs;
  let okMetered = 0;
  let faltaMetered = 0;
  let sinSub = 0;
  let planPagoSinSub = 0;
  let subCancelada = 0;
  let errores = 0;

  for (const doc of docs) {
    const data = doc.data() || {};
    const email = userEmail(data);
    const uid = doc.id;
    const planRaw = data.plan;
    const planFs = planFromFirestore(planRaw);
    const subId =
      typeof data.stripeSubscriptionId === 'string'
        ? data.stripeSubscriptionId.trim()
        : '';

    if (!subId) {
      sinSub++;
      if (planFs) {
        planPagoSinSub++;
        console.log(
          `[problema] ${email} | ${uid} | plan=${planRaw} pero sin stripeSubscriptionId en Firestore`,
        );
      }
      continue;
    }

    try {
      const subscription = await stripe.subscriptions.retrieve(subId, {
        expand: ['items.data.price'],
      });
      const items = subscription.items?.data || [];
      const hasM = subscriptionHasMetered(items, meteredSet);

      if (
        subscription.status === 'canceled' ||
        subscription.status === 'incomplete_expired'
      ) {
        subCancelada++;
        console.log(
          `[sub_inactiva] ${email} | ${uid} | sub=${subId} | status=${subscription.status} | plan FS=${planRaw ?? 'null'}`,
        );
        continue;
      }

      if (hasM) {
        okMetered++;
        console.log(
          `[ok] ${email} | ${uid} | sub=${subId} | metered=sí | plan FS=${planRaw ?? 'null'}`,
        );
      } else {
        faltaMetered++;
        console.log(
          `[falta_metered] ${email} | ${uid} | sub=${subId} | plan FS=${planRaw ?? 'null'} — ejecutar migración para añadir ítem`,
        );
      }
    } catch (e) {
      errores++;
      console.error(
        `[error] ${email} | ${uid} | sub=${subId}: ${e.message || e}`,
      );
    }
    await new Promise((r) => setTimeout(r, 120));
  }

  console.log('\n--- Resumen verify ---');
  console.log(
    `Con sub en Stripe + metered OK: ${okMetered} | Falta metered (revisar migración): ${faltaMetered}`,
  );
  console.log(
    `Sin stripeSubscriptionId en FS: ${sinSub} | De ellos plan de pago sin sub (error datos): ${planPagoSinSub}`,
  );
  console.log(
    `Suscripción Stripe cancelada/expirada: ${subCancelada} | Errores API: ${errores}`,
  );
}

async function main() {
  loadEnvFromDotenv();
  const dryRun = process.argv.includes('--dry-run');
  const verifyOnly = process.argv.includes('--verify');
  const userIdArg = process.argv.find((a) => a.startsWith('--user-id='));
  const singleUserId = userIdArg ? userIdArg.split('=')[1]?.trim() : null;

  const secret = trimEnv('STRIPE_SECRET_KEY');
  if (!secret) {
    console.error('Falta STRIPE_SECRET_KEY en el entorno.');
    process.exit(1);
  }

  const baseRows = buildBasePriceRows();
  const meteredSet = buildMeteredPriceSet();
  if (baseRows.length === 0) {
    console.error(
      'No hay precios base STRIPE_PRICE_* configurados; revisa el .env o las variables.',
    );
    process.exit(1);
  }
  if (meteredSet.size === 0) {
    console.error(
      'No hay precios metered STRIPE_PRICE_*_METERED configurados.',
    );
    process.exit(1);
  }

  if (dryRun && !verifyOnly) {
    console.log(
      '🔍 dry-run: se leen suscripciones en Stripe pero no se crean ítems metered.\n',
    );
  }

  const serviceAccount = loadServiceAccount();
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  }

  const stripe = new Stripe(secret);
  const db = admin.firestore();

  if (verifyOnly) {
    await runVerifyOnly(stripe, db, meteredSet);
    return;
  }

  let docs;
  if (singleUserId) {
    const d = await db.collection('users').doc(singleUserId).get();
    docs = d.exists ? [d] : [];
    if (!d.exists) {
      console.error(`Usuario ${singleUserId} no existe en Firestore.`);
      process.exit(1);
    }
  } else {
    docs = (await db.collection('users').get()).docs;
  }

  let processed = 0;
  let added = 0;
  let skipped = 0;
  let errors = 0;

  for (const doc of docs) {
    const data = doc.data() || {};
    const subId =
      typeof data.stripeSubscriptionId === 'string'
        ? data.stripeSubscriptionId.trim()
        : '';
    if (!subId) {
      console.log(
        `[skip] ${userEmail(data)} | ${doc.id} | motivo: sin stripeSubscriptionId en Firestore`,
      );
      skipped++;
      continue;
    }

    const planFs = planFromFirestore(data.plan);
    if (!singleUserId && !planFs) {
      console.log(
        `[skip] ${userEmail(data)} | ${doc.id} | motivo: plan no es starter/growth/scale (plan=${data.plan ?? 'null'})`,
      );
      skipped++;
      continue;
    }

    processed++;

    try {
      const subscription = await stripe.subscriptions.retrieve(subId, {
        expand: ['items.data.price'],
      });

      if (
        subscription.status === 'canceled' ||
        subscription.status === 'incomplete_expired'
      ) {
        console.log(
          `[skip] ${userEmail(data)} | ${doc.id} | motivo: suscripción Stripe ${subscription.status} | sub=${subId}`,
        );
        skipped++;
        continue;
      }

      const items = subscription.items?.data || [];
      let hasMetered = false;
      for (const item of items) {
        const pid = item.price?.id;
        if (pid && meteredSet.has(pid)) {
          hasMetered = true;
          break;
        }
        if (item.price?.recurring?.usage_type === 'metered') {
          hasMetered = true;
          break;
        }
      }

      if (hasMetered) {
        console.log(
          `[skip] ${userEmail(data)} | ${doc.id} | motivo: ya tiene ítem metered | sub=${subId}`,
        );
        skipped++;
        continue;
      }

      const detected = detectPlanAndIntervalFromItems(subscription, baseRows);
      let plan = detected?.plan ?? planFs;
      let interval = detected?.interval;
      if (!interval) {
        for (const item of subscription.items?.data || []) {
          const pr = item.price;
          if (pr?.recurring?.usage_type === 'metered') continue;
          if (pr?.recurring?.interval) {
            interval = pr.recurring.interval === 'year' ? 'year' : 'month';
            break;
          }
        }
      }
      if (!interval) {
        interval = 'month';
      }
      if (!plan) {
        console.warn(
          `[warn] ${userEmail(data)} | ${doc.id} | no se pudo inferir plan para sub ${subId}; omitiendo.`,
        );
        skipped++;
        continue;
      }

      const meteredPriceId = meteredPriceForPlan(plan, interval);
      if (!meteredPriceId) {
        console.warn(
          `[warn] ${userEmail(data)} | ${doc.id} | falta env metered para plan=${plan} interval=${interval}`,
        );
        errors++;
        continue;
      }

      console.log(
        `[add] ${userEmail(data)} | ${doc.id} | sub=${subId} | plan=${plan} | interval=${interval} | meteredPrice=${meteredPriceId}`,
      );

      if (!dryRun) {
        /** Los precios metered no deben llevar quantity en algunos modos; Stripe acepta quantity 1 en muchos casos. */
        await stripe.subscriptionItems.create({
          subscription: subId,
          price: meteredPriceId,
        });
        added++;
      } else {
        added++;
      }

      await new Promise((r) => setTimeout(r, 150));
    } catch (e) {
      errors++;
      console.error(
        `[error] ${userEmail(data)} | ${doc.id} | sub=${subId}: ${e.message || e}`,
      );
    }
  }

  console.log('\n---');
  console.log(
    `Procesados con sub: ${processed}, añadidos metered: ${added}, omitidos: ${skipped}, errores: ${errors}`,
  );
  if (dryRun && added > 0) {
    console.log('(dry-run: no se crearon ítems reales en Stripe)');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
