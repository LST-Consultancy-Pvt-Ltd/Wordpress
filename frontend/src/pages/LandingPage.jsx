import { motion } from "framer-motion";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  Bot,
  CheckCircle2,
  Gauge,
  Globe,
  Play,
  Search,
  Sparkles,
  Target,
  Zap,
} from "lucide-react";

const featureCards = [
  {
    icon: Sparkles,
    title: "AI command center",
    description: "Run multi-step WordPress tasks from one command box and monitor execution in real time.",
  },
  {
    icon: Search,
    title: "SEO intelligence",
    description: "Track rankings, audit technical SEO, and prioritize fixes with impact-focused recommendations.",
  },
  {
    icon: Globe,
    title: "Multi-site control",
    description: "Connect multiple WordPress sites and operate everything from one fast, unified workspace.",
  },
  {
    icon: Target,
    title: "Autopilot campaigns",
    description: "Launch content refreshes, backlink workflows, and publishing queues on repeatable schedules.",
  },
  {
    icon: Gauge,
    title: "Health and uptime",
    description: "Watch site health, plugin risks, and critical incidents before they become outages.",
  },
  {
    icon: CheckCircle2,
    title: "Human approvals",
    description: "Switch between automatic and manual apply modes to keep high-risk changes under review.",
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
            <span className="font-heading text-sm font-bold">WP Autopilot</span>
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
              Manage WordPress like an AI operations team.
            </motion.h1>

            <motion.p
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1, duration: 0.45 }}
              className="mx-auto mt-7 max-w-2xl text-base text-zinc-600 sm:text-lg"
            >
              Connect sites, run SEO workflows, ship content, and monitor health from one precision dashboard.
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
              <button className="inline-flex items-center gap-2 rounded-full bg-zinc-900 px-4 py-2 text-xs font-semibold text-white">
                <Play size={12} />
                Product walkthrough
              </button>
            </div>

            <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-zinc-950 p-4 shadow-[0_25px_80px_rgba(17,17,17,0.20)] md:p-6">
              <div className="grid min-h-[320px] gap-0 overflow-hidden rounded-xl border border-white/10 md:grid-cols-[220px_1fr_1fr]">
                <aside className="border-r border-white/10 bg-black/80 p-4">
                  <div className="mb-4 flex items-center gap-2 border-b border-white/10 pb-3">
                    <div className="flex h-7 w-7 items-center justify-center rounded-md bg-indigo-500/20 text-indigo-300">
                      <Zap size={14} />
                    </div>
                    <p className="font-heading text-xs font-bold text-white">WP Autopilot</p>
                  </div>

                  <p className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Core</p>
                  <div className="space-y-1 text-xs">
                    <div className="rounded-md bg-indigo-500/15 px-2 py-1 text-indigo-300">Dashboard</div>
                    <div className="rounded-md px-2 py-1 text-zinc-500">Sites</div>
                    <div className="rounded-md px-2 py-1 text-zinc-500">AI Command</div>
                  </div>

                  <p className="mb-1 mt-4 px-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">SEO</p>
                  <div className="space-y-1 text-xs">
                    <div className="rounded-md px-2 py-1 text-zinc-500">Keyword tracking</div>
                    <div className="rounded-md px-2 py-1 text-zinc-500">Site speed</div>
                  </div>
                </aside>

                <div className="border-r border-white/10 bg-zinc-950 p-4 md:p-5">
                  <h3 className="font-heading text-sm font-bold text-white">Dashboard</h3>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    {[
                      ["24", "Sites"],
                      ["1,482", "Pages"],
                      ["93", "Tasks"],
                      ["99.9%", "Uptime"],
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
                        <span>SEO audit complete</span>
                        <span className="text-emerald-400">OK</span>
                      </div>
                      <div className="flex items-center justify-between text-zinc-400">
                        <span>New post scheduled</span>
                        <span className="text-indigo-300">Queued</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="bg-zinc-950 p-4 md:p-5">
                  <p className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-indigo-300">
                    <Bot size={12} />
                    AI command
                  </p>
                  <div className="mt-2 rounded-md border border-indigo-400/25 bg-indigo-500/10 p-3 text-xs text-zinc-300">
                    Generate a content refresh plan for all pages with CTR below 1.5%.
                  </div>
                  <div className="mt-2 rounded-md border border-white/10 bg-white/5 p-3">
                    <p className="font-mono text-[11px] leading-5 text-zinc-500">
                      scanning pages...
                      <br />
                      collecting SEO metrics...
                      <br />
                      <span className="text-emerald-400">complete: 42 recommendations ready</span>
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
              Built for technical growth teams
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
                Ready to automate your WordPress operations?
              </h3>
              <p className="mt-2 max-w-2xl text-sm text-zinc-600">
                Start with one site, then scale into a complete AI-managed publishing and SEO workflow.
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
