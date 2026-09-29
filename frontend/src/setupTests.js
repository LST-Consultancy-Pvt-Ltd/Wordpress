import "@testing-library/jest-dom";
import { TextEncoder, TextDecoder } from "util";

// react-router v7 expects these globals.
if (!global.TextEncoder) global.TextEncoder = TextEncoder;
if (!global.TextDecoder) global.TextDecoder = TextDecoder;

// Radix primitives rely on browser APIs jsdom lacks.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!global.ResizeObserver) global.ResizeObserver = ResizeObserverStub;
if (!window.matchMedia) {
  window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
}
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => {};
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

// Recording EventSource: tests assert on the URLs that were opened.
class FakeEventSource {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    FakeEventSource.instances.push(this);
  }
  close() {
    this.readyState = 2;
  }
  emit(data) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}
global.EventSource = FakeEventSource;
global.FakeEventSource = FakeEventSource;

beforeEach(() => {
  FakeEventSource.instances = [];
  window.localStorage.clear();
});
