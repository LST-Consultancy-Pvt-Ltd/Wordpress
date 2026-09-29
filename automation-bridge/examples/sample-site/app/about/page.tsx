import type { Metadata } from "next";
import { AutomationJsonLd, EditableRichText, withAutomationMetadata } from "@lst/automation-bridge/next";

export async function generateMetadata(): Promise<Metadata> {
  return withAutomationMetadata("/about", { title: "About us", description: "Who we are." });
}

export default function AboutPage() {
  return (
    <main>
      <AutomationJsonLd route="/about" />
      <h1>About</h1>
      <EditableRichText id="about.body">{"<p>We build small, fast websites.</p>"}</EditableRichText>
    </main>
  );
}
