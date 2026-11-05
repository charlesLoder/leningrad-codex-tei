/** Lucide icons as SVG strings, for Astro templates and for HTML that the page script writes. */
import {
  ArrowLeft,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  CodeXml,
  Ellipsis,
  ExternalLink,
  Image,
  ImageOff,
  Minus,
  Plus,
  Printer,
  X,
} from 'lucide-static';

// Every icon sits beside text or inside a labeled button, so it is hidden from screen readers.
const decorative = (svg: string): string => svg.replace('<svg', '<svg aria-hidden="true" focusable="false"');

export const icons = {
  arrowLeft: decorative(ArrowLeft),
  arrowRight: decorative(ArrowRight),
  chevronLeft: decorative(ChevronLeft),
  chevronRight: decorative(ChevronRight),
  codeXml: decorative(CodeXml),
  ellipsis: decorative(Ellipsis),
  externalLink: decorative(ExternalLink),
  image: decorative(Image),
  imageOff: decorative(ImageOff),
  minus: decorative(Minus),
  plus: decorative(Plus),
  printer: decorative(Printer),
  x: decorative(X),
};
