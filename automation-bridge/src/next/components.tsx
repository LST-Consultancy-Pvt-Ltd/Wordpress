/**
 * Server components for editable content. Every id must be registered in
 * `automation.manifest.json`; the bridge refuses writes to unregistered ids.
 *
 *   <h1><EditableText id="home.hero.title">Build faster</EditableText></h1>
 *   <EditableRichText id="about.body">{"<p>Default copy</p>"}</EditableRichText>
 *   <EditableImage id="home.hero.image" src="/hero.svg" alt="Default alt" width={640} height={320} />
 *   <AutomationJsonLd route="/about" />
 *
 * Pages using these must be eligible for revalidation (not `force-static`).
 */
import type { ImgHTMLAttributes, ReactElement } from "react";
import { getAutomationJsonLd, getBlock, getImageAlt, getRichTextBlockHtml, serializeJsonLd } from "./runtime.js";

export async function EditableText({ id, children }: { id: string; children?: string }): Promise<ReactElement> {
  const text = await getBlock(id, typeof children === "string" ? children : "");
  return <>{text}</>;
}

/** Rich text is sanitised with the protocol allow-list right before rendering. */
export async function EditableRichText({ id, children, className }: { id: string; children?: string; className?: string }): Promise<ReactElement> {
  const html = await getRichTextBlockHtml(id, typeof children === "string" ? children : "");
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}

type EditableImageProps = { id: string; src: string; alt: string } & Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "alt">;

export async function EditableImage({ id, src, alt, ...rest }: EditableImageProps): Promise<ReactElement> {
  const resolved = await getImageAlt(id, alt);
  return <img src={src} alt={resolved} {...rest} />;
}

/** JSON-LD from the metadata override store (plus optional `extra`, e.g. front matter `jsonLd`). */
export async function AutomationJsonLd({ route, extra }: { route: string; extra?: unknown }): Promise<ReactElement | null> {
  const items = await getAutomationJsonLd(route, extra);
  if (!items.length) return null;
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(items) }} />;
}
