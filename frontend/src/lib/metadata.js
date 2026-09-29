/**
 * MetadataFields (protocol/automation-bridge-v1.md §7): form conversion and
 * client-side validation mirroring the bridge's rules.
 */

export const EMPTY_FORM = {
  title: "",
  description: "",
  canonical: "",
  robotsSet: false,
  index: true,
  follow: true,
  ogTitle: "",
  ogDescription: "",
  ogImage: "",
  jsonLd: "",
};

export function fieldsToForm(fields = {}) {
  return {
    title: fields.title || "",
    description: fields.description || "",
    canonical: fields.canonical || "",
    robotsSet: !!fields.robots,
    index: fields.robots ? fields.robots.index !== false : true,
    follow: fields.robots ? fields.robots.follow !== false : true,
    ogTitle: fields.openGraph?.title || "",
    ogDescription: fields.openGraph?.description || "",
    ogImage: fields.openGraph?.image || "",
    jsonLd: fields.jsonLd?.length ? JSON.stringify(fields.jsonLd, null, 2) : "",
  };
}

const isUrlOrPath = (v) => /^\//.test(v) || /^https?:\/\/\S+$/i.test(v);

export function validateMetadataForm(f) {
  const errors = {};
  if (f.title.length > 300) errors.title = `Title is ${f.title.length} characters; the maximum is 300.`;
  if (f.description.length > 1000) errors.description = `Description is ${f.description.length} characters; the maximum is 1000.`;
  if (f.canonical && !(/^\//.test(f.canonical) || /^https:\/\/\S+$/i.test(f.canonical))) {
    errors.canonical = "Canonical must be an absolute https:// URL or a path starting with /.";
  }
  if (f.ogImage && !isUrlOrPath(f.ogImage)) errors.ogImage = "Image must be a URL or a path starting with /.";
  if (f.jsonLd.trim()) {
    try {
      const parsed = JSON.parse(f.jsonLd);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      if (arr.some((x) => !x || typeof x !== "object" || Array.isArray(x))) errors.jsonLd = "JSON-LD must be an object or an array of objects.";
      else if (arr.some((x) => !x["@type"])) errors.jsonLd = 'Every JSON-LD object needs an "@type".';
      else if (new Blob([JSON.stringify(arr)]).size > 32 * 1024) errors.jsonLd = "JSON-LD exceeds 32 KiB.";
    } catch (e) {
      errors.jsonLd = `Invalid JSON: ${e.message}`;
    }
  }
  return errors;
}

export function formToFields(f) {
  const fields = {};
  if (f.title.trim()) fields.title = f.title.trim();
  if (f.description.trim()) fields.description = f.description.trim();
  if (f.canonical.trim()) fields.canonical = f.canonical.trim();
  if (f.robotsSet) fields.robots = { index: !!f.index, follow: !!f.follow };
  const og = {};
  if (f.ogTitle.trim()) og.title = f.ogTitle.trim();
  if (f.ogDescription.trim()) og.description = f.ogDescription.trim();
  if (f.ogImage.trim()) og.image = f.ogImage.trim();
  if (Object.keys(og).length) fields.openGraph = og;
  if (f.jsonLd.trim()) {
    const parsed = JSON.parse(f.jsonLd);
    fields.jsonLd = Array.isArray(parsed) ? parsed : [parsed];
  }
  return fields;
}
