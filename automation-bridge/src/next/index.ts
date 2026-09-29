/** Site runtime helpers (read-only). Import from "@lst/automation-bridge/next". */
export {
  configureAutomation,
  overridesDir,
  withAutomationMetadata,
  getMetadataOverride,
  getAutomationJsonLd,
  serializeJsonLd,
  getBlock,
  getRichTextBlockHtml,
  getImageAlt,
  getRedirects,
  matchRedirect,
  renderContentHtml,
  sanitizeRichText,
  sanitizeArticleHtml,
} from "./runtime.js";
export { EditableText, EditableRichText, EditableImage, AutomationJsonLd } from "./components.js";
