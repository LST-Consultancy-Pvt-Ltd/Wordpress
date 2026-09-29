import type { Metadata } from "next";
import { withAutomationMetadata } from "@lst/automation-bridge/next";
import { listPosts } from "@/lib/content";

export async function generateMetadata(): Promise<Metadata> {
  return withAutomationMetadata("/blog", { title: "Blog" });
}

export default async function BlogIndex() {
  const posts = await listPosts();
  return (
    <main>
      <h1>Blog</h1>
      <ul>
        {posts.map((p) => (
          <li key={p.slug}>
            <a href={`/blog/${p.slug}`}>{String(p.frontmatter.title ?? p.slug)}</a>
          </li>
        ))}
      </ul>
    </main>
  );
}
