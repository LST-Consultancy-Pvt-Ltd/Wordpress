import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AutomationJsonLd, withAutomationMetadata } from "@lst/automation-bridge/next";
import { getPost, postHtml } from "@/lib/content";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const post = await getPost(slug);
  if (!post) return {};
  const fm = post.frontmatter;
  const keywords = Array.isArray(fm.keywords) ? fm.keywords.map(String) : typeof fm.keywords === "string" ? fm.keywords : undefined;
  return withAutomationMetadata(`/blog/${slug}`, {
    title: String(fm.title ?? slug),
    description: typeof fm.description === "string" ? fm.description : undefined,
    keywords,
  });
}

export default async function PostPage({ params }: Props) {
  const { slug } = await params;
  const post = await getPost(slug);
  if (!post) notFound();
  const fm = post.frontmatter;
  const tags = Array.isArray(fm.tags) ? fm.tags.map(String) : [];
  return (
    <article>
      {/* JSON-LD from the post's front matter and any bridge override, escaped by the helper. */}
      <AutomationJsonLd route={`/blog/${slug}`} extra={fm.jsonLd} />
      <h1>{String(fm.title ?? slug)}</h1>
      {tags.length > 0 && <p>Tags: {tags.join(", ")}</p>}
      {/* postHtml() sanitises both Markdown output and content_format: "html" bodies. */}
      <div dangerouslySetInnerHTML={{ __html: postHtml(post) }} />
    </article>
  );
}
