import { motion } from "framer-motion";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  Bot,
  CheckCircle2,
  DatabaseBackup,
  GitPullRequest,
  Play,
  Plug,
  Rocket,
  ScrollText,
  Zap,
} from "lucide-react";

const featureCards = [
  {
    icon: Plug,
    title: "Bridge agent connections",
    description: "Connect Next.js sites through a lightweight bridge agent with signed requests, per-site credentials and read-only mode by default.",
  },
  {
    icon: GitPullRequest,
    title: "Reviewable change sets",
    description: "Every content, metadata, redirect or file edit becomes a change set you can plan, validate, diff and preview before it ships.",
  },
  {
    icon: CheckCircle2,
    title: "Role-based approvals",
    description: "Editors propose, deployers approve and apply. Nothing reaches a production site without the right person signing off.",
  },
  {
    icon: Rocket,
    title: "Deployments and rollbacks",
    description: "Trigger deployments per environment, follow their progress and roll back an applied change or deployment in one step.",
  },
  {
    icon: DatabaseBackup,
    title: "Backups and restore",
    description: "Take backups before risky changes and restore content or files when something needs to be undone.",
  },
  {
    icon: ScrollText,
    title: "Full audit trail",
    description: "Every proposal, approval, apply and credential change is recorded with who did it, when, and the bridge correlation id.",
  },
];

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-white text-zinc-900">
      <header className="fixed inset-x-0 top-0 z-50 border-b border-zinc-200/70 bg-white/85 backdrop-blur-xl">
        <nav className="mx-auto flex h-14 w-full max-w-7xl items-center px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-zinc-900 text-white">
              <Zap size={16} />
            </div>
            <span className="font-heading text-sm font-bold">Site Autopilot</span>
          </div>

          <div className="ml-8 hidden items-center gap-1 md:flex">
            {[
              ["Features", "#features"],
              ["Preview", "#preview"],
              ["Why us", "#why"],
            ].map(([label, href]) => (
              <a
                key={label}
                href={href}
                className="rounded-md px-3 py-1.5 text-sm font-medium text-zinc-600 transition hover:bg-zinc-100 hover:text-zinc-900"
              >
                {label}
              </a>
            ))}
          </div>

          <div className="ml-auto flex items-center gap-2">
            <Link
              to="/login"
              className="hidden rounded-full border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100 sm:inline-flex"
            >
              Sign in
            </Link>
            <Link
              to="/register"
              className="inline-flex items-center gap-1 rounded-full bg-zinc-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-zinc-800"
            >
              Start free
              <ArrowRight size={14} />
            </Link>
          </div>
        </nav>
      </header>

      <main>
        <section className="relative overflow-hidden px-4 pb-10 pt-28 sm:px-6 lg:px-8 lg:pt-32">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_10%,rgba(0,0,0,0.04),transparent_45%),radial-gradient(circle_at_80%_20%,rgba(99,102,241,0.10),transparent_40%)]" />

          <div className="relative mx-auto max-w-6xl text-center">
            <motion.h1
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5 }}
              className="font-heading text-5xl font-extrabold leading-[0.95] tracking-[-0.03em] text-zinc-900 sm:text-7xl lg:text-8xl"
            >
              Automate your Next.js sites without losing control.
            </motion.h1>

            <motion.p
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1, duration: 0.45 }}
              className="mx-auto mt-7 max-w-2xl text-base text-zinc-600 sm:text-lg"
            >
              Site Autopilot is the Next.js automation platform: connect sites through a bridge agent, turn every edit into a reviewable change set, and ship through approvals, deployments, backups and a complete audit trail.
            </motion.p>

            <motion.div
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.18, duration: 0.45 }}
              className="mt-8 flex flex-wrap items-center justify-center gap-3"
            >
              <Link
                to="/register"
                className="inline-flex items-center gap-2 rounded-full bg-zinc-900 px-6 py-3 text-sm font-semibold text-white transition hover:bg-zinc-800"
              >
                Start free
                <ArrowRight size={16} />
              </Link>
              <a
                href="#preview"
                className="inline-flex items-center gap-2 rounded-full border border-zinc-300 px-6 py-3 text-sm font-medium text-zinc-800 transition hover:bg-zinc-100"
              >
                See product preview
              </a>
            </motion.div>
          </div>
        </section>

        <section id="preview" className="px-4 pb-16 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-6xl">
            <div className="mb-3 flex justify-center">
              <span className="inline-flex items-center gap-2 rounded-full bg-zinc-900 px-4 py-2 text-xs font-semibold text-white">
                <Play size={12} aria-hidden="true" />
                Product walkthrough
              </span>
            </div>

            <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-zinc-950 p-4 shadow-[0_25px_80px_rgba(17,17,17,0.20)] md:p-6">
              <div className="grid min-h-[320px] gap-0 overflow-hidden rounded-xl border border-white/10 md:grid-cols-[220px_1fr_1fr]">
                <aside className="border-r border-white/10 bg-black/80 p-4">
                  <div className="mb-4 flex items-center gap-2 border-b border-white/10 pb-3">
                    <div className="flex h-7 w-7 items-center justify-center rounded-md bg-indigo-500/20 text-indigo-300">
                      <Zap size={14} />
                    </div>
                    <p className="font-heading text-xs font-bold text-white">Site Autopilot</p>
                  </div>

                  <p className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Core</p>
                  <div className="space-y-1 text-xs">
                    <div className="rounded-md bg-indigo-500/15 px-2 py-1 text-indigo-300">Dashboard</div>
                    <div className="rounded-md px-2 py-1 text-zinc-500">Sites</div>
                    <div className="rounded-md px-2 py-1 text-zinc-500">Change sets</div>
                  </div>

                  <p className="mb-1 mt-4 px-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Operations</p>
                  <div className="space-y-1 text-xs">
                    <div className="rounded-md px-2 py-1 text-zinc-500">Deployments</div>
                    <div className="rounded-md px-2 py-1 text-zinc-500">Audit log</div>
                  </div>
                </aside>

                <div className="border-r border-white/10 bg-zinc-950 p-4 md:p-5">
                  <h3 className="font-heading text-sm font-bold text-white">Dashboard</h3>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    {[
                      ["12", "Connected sites"],
                      ["4", "Awaiting approval"],
                      ["38", "Applied this week"],
                      ["0", "Failed deploys"],
                    ].map(([value, label]) => (
                      <div key={label} className="rounded-md border border-white/10 bg-white/5 p-2.5">
                        <p className="font-heading text-sm font-bold text-white">{value}</p>
                        <p className="text-[10px] text-zinc-500">{label}</p>
                      </div>
                    ))}
                  </div>

                  <div className="mt-3 rounded-md border border-white/10 bg-white/5 p-3">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Recent actions</p>
                    <div className="mt-2 space-y-2 text-[11px]">
                      <div className="flex items-center justify-between text-zinc-400">
                        <span>Change set applied to production</span>
                        <span className="text-emerald-400">Applied</span>
                      </div>
                      <div className="flex items-center justify-between text-zinc-400">
                        <span>Metadata update submitted</span>
                        <span className="text-indigo-300">Pending approval</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="bg-zinc-950 p-4 md:p-5">
                  <p className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-indigo-300">
                    <Bot size={12} aria-hidden="true" />
                    AI command
                  </p>
                  <div className="mt-2 rounded-md border border-indigo-400/25 bg-indigo-500/10 p-3 text-xs text-zinc-300">
                    Propose meta description fixes for every blog route with a CTR below 1.5%.
                  </div>
                  <div className="mt-2 rounded-md border border-white/10 bg-white/5 p-3">
                    <p className="font-mono text-[11px] leading-5 text-zinc-500">
                      reading routes via bridge...
                      <br />
                      planning 42 metadata.set operations...
                      <br />
                      <span className="text-emerald-400">change set ready for review</span>
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section id="features" className="px-4 pb-16 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-6xl">
            <p className="text-center text-xs font-semibold uppercase tracking-[0.12em] text-zinc-500">Platform capabilities</p>
            <h2 className="mt-3 text-center font-heading text-4xl font-extrabold tracking-[-0.03em] text-zinc-900 sm:text-5xl">
              Built for teams that ship Next.js sites
            </h2>

            <div className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {featureCards.map((feature, index) => (
                <motion.article
                  key={feature.title}
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true, amount: 0.25 }}
                  transition={{ delay: index * 0.05, duration: 0.35 }}
                  className="rounded-2xl border border-zinc-200 bg-zinc-50 p-6 transition hover:bg-zinc-100"
                >
                  <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-zinc-900 text-white">
                    <feature.icon size={18} />
                  </div>
                  <h3 className="font-heading text-lg font-bold text-zinc-900">{feature.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-zinc-600">{feature.description}</p>
                </motion.article>
              ))}
            </div>
          </div>
        </section>

        <section id="why" className="border-t border-zinc-200 px-4 py-16 sm:px-6 lg:px-8">
          <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-6 text-center md:flex-row md:text-left">
            <div>
              <h3 className="font-heading text-3xl font-extrabold tracking-[-0.03em] text-zinc-900">
                Ready to put your Next.js sites on autopilot?
              </h3>
              <p className="mt-2 max-w-2xl text-sm text-zinc-600">
                Start with one site in read-only mode, then enable writes when your approval workflow is in place.
              </p>
            </div>
            <Link
              to="/register"
              className="inline-flex items-center gap-2 rounded-full bg-zinc-900 px-6 py-3 text-sm font-semibold text-white transition hover:bg-zinc-800"
            >
              Create account
              <ArrowRight size={16} />
            </Link>
          </div>
        </section>
      </main>
    </div>
  );
}
