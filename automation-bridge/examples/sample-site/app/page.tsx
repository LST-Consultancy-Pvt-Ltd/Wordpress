import type { Metadata } from "next";
import { EditableImage, EditableText, withAutomationMetadata } from "@lst/automation-bridge/next";

export async function generateMetadata(): Promise<Metadata> {
  return withAutomationMetadata("/", { title: "Sample site", description: "A minimal site managed by the Automation Bridge." });
}

export default function HomePage() {
  return (
    <main>
      <h1>
        <EditableText id="home.hero.title">Build faster with less</EditableText>
      </h1>
      <p>
        <EditableText id="home.hero.subtitle">Everything here can be edited through the bridge.</EditableText>
      </p>
      <EditableImage id="home.hero.image" src="/hero.svg" alt="Abstract hero illustration" width={640} height={240} />
    </main>
  );
}
