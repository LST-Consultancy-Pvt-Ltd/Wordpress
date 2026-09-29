// Deliberately NOT opted in: static metadata. The bridge's inventory reports
// this route as "static", and metadata.set on /contact returns the plan
// warning METADATA_NOT_OPTED_IN with effective: false.
export const metadata = { title: "Contact", description: "Get in touch." };

export default function ContactPage() {
  return (
    <main>
      <h1>Contact</h1>
      <p>hello@example.com</p>
    </main>
  );
}
