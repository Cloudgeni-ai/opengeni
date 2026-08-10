import {
  PresentationSecurityError,
  type PresentationPptxImportLimits,
} from "./presentation-pptx-api";

export type PptxXmlNode = PptxXmlElement | { type: "text"; value: string };

export type PptxXmlElement = {
  type: "element";
  name: string;
  localName: string;
  attributes: ReadonlyMap<string, string>;
  /** Resolved namespace bindings, populated by parsePptxXmlPart validation. */
  namespaceUri?: string;
  attributeNamespaces?: ReadonlyMap<string, string | undefined>;
  children: PptxXmlNode[];
};

export type PptxXmlBudget = {
  limits: PresentationPptxImportLimits;
  totalBytes: number;
  totalNodes: number;
};

export function parsePptxXmlPart(
  bytes: Uint8Array,
  partName: string,
  budget: PptxXmlBudget,
): PptxXmlElement {
  if (bytes.byteLength > budget.limits.xmlBytes) {
    throw pptxXmlLimit("XML part exceeds its byte limit", partName);
  }
  budget.totalBytes += bytes.byteLength;
  if (budget.totalBytes > budget.limits.totalXmlBytes) {
    throw pptxXmlLimit("PPTX exceeds its total XML byte limit", partName);
  }
  let xml: string;
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      xml = new TextDecoder("utf-16le", { fatal: true }).decode(bytes);
    } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      xml = new TextDecoder("utf-16be", { fatal: true }).decode(bytes);
    } else {
      xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }
  } catch {
    throw pptxXmlSecurity("OOXML text is not valid UTF-8 or UTF-16", "unsafe-xml", partName);
  }
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) {
    throw pptxXmlSecurity("DOCTYPE and entity declarations are forbidden", "unsafe-xml", partName);
  }
  const parsed = parseXml(xml, partName, budget);
  validateNamespaceBindings(parsed, partName, new Map());
  return parsed;
}

function parseXml(xml: string, partName: string, budget: PptxXmlBudget): PptxXmlElement {
  const stack: PptxXmlElement[] = [];
  let root: PptxXmlElement | undefined;
  let cursor = 0;
  let sawDeclaration = false;
  const addNode = (node: PptxXmlNode): void => {
    budget.totalNodes += 1;
    if (budget.totalNodes > budget.limits.xmlNodes) {
      throw pptxXmlLimit("PPTX exceeds its XML node limit", partName);
    }
    const parent = stack.at(-1);
    if (parent) parent.children.push(node);
    else if (node.type === "text" && isXmlWhitespace(node.value)) return;
    else if (node.type === "element" && !root) root = node;
    else
      throw pptxXmlSecurity(
        "XML has text outside its root or multiple roots",
        "unsafe-xml",
        partName,
      );
  };

  while (cursor < xml.length) {
    const opening = xml.indexOf("<", cursor);
    if (opening < 0) {
      if (cursor < xml.length)
        addNode({ type: "text", value: decodeEntities(xml.slice(cursor), partName) });
      cursor = xml.length;
      break;
    }
    if (opening > cursor) {
      addNode({ type: "text", value: decodeEntities(xml.slice(cursor, opening), partName) });
    }
    if (xml.startsWith("<!--", opening)) {
      const end = xml.indexOf("-->", opening + 4);
      const body = end < 0 ? "" : xml.slice(opening + 4, end);
      if (end < 0 || body.includes("--") || body.endsWith("-")) {
        throw pptxXmlSecurity("Malformed XML comment", "unsafe-xml", partName);
      }
      validateXmlCharacters(body, partName);
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith("<?", opening)) {
      const end = xml.indexOf("?>", opening + 2);
      const instruction = end < 0 ? "" : xml.slice(opening + 2, end);
      const declaration =
        /^xml[\x20\t\r\n]+version=(?:"1\.[01]"|'1\.[01]')(?:[\x20\t\r\n]+encoding=(?:"[Uu][Tt][Ff]-(?:8|16)"|'[Uu][Tt][Ff]-(?:8|16)'))?(?:[\x20\t\r\n]+standalone=(?:"(?:yes|no)"|'(?:yes|no)'))?[\x20\t\r\n]*$/.test(
          instruction,
        );
      if (end < 0 || !declaration || opening !== 0 || root || stack.length > 0 || sawDeclaration) {
        throw pptxXmlSecurity(
          "XML processing instructions are unsupported",
          "unsafe-xml",
          partName,
        );
      }
      sawDeclaration = true;
      cursor = end + 2;
      continue;
    }
    if (xml.startsWith("<!", opening)) {
      throw pptxXmlSecurity("XML declarations and CDATA are unsupported", "unsafe-xml", partName);
    }
    const end = findTagEnd(xml, opening + 1, partName);
    const source = xml.slice(opening + 1, end);
    if (source.startsWith("/")) {
      const match = /^\/([^\x20\t\r\n]+)[\x20\t\r\n]*$/.exec(source);
      const name = match?.[1];
      if (!name || !XML_QNAME.test(name)) {
        throw pptxXmlSecurity("Malformed XML closing tag", "unsafe-xml", partName);
      }
      const current = stack.pop();
      if (!current || current.name !== name) {
        throw pptxXmlSecurity("Mismatched XML closing tag", "unsafe-xml", partName);
      }
    } else {
      if (isXmlSpace(source[0])) {
        throw pptxXmlSecurity("XML start tag has leading whitespace", "unsafe-xml", partName);
      }
      const selfClosing = /\/[\x20\t\r\n]*$/.test(source);
      const body = selfClosing ? source.replace(/\/[\x20\t\r\n]*$/, "") : source;
      const element = parseStartTag(body, partName, budget.limits.xmlAttributesPerElement);
      addNode(element);
      if (!selfClosing) {
        stack.push(element);
        if (stack.length > budget.limits.xmlDepth) {
          throw pptxXmlLimit("XML exceeds its depth limit", partName);
        }
      }
    }
    cursor = end + 1;
  }
  if (stack.length > 0 || !root) {
    throw pptxXmlSecurity("XML is empty or ends with unclosed elements", "unsafe-xml", partName);
  }
  return root;
}

function findTagEnd(xml: string, start: number, partName: string): number {
  let quote: string | undefined;
  for (let index = start; index < xml.length; index += 1) {
    const character = xml[index];
    if (quote) {
      if (character === quote) quote = undefined;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === ">") return index;
  }
  throw pptxXmlSecurity("Unterminated XML tag", "unsafe-xml", partName);
}

function parseStartTag(source: string, partName: string, maxAttributes: number): PptxXmlElement {
  let cursor = 0;
  const skipSpace = (): void => {
    while (cursor < source.length && isXmlSpace(source[cursor])) cursor += 1;
  };
  const nameStart = cursor;
  while (cursor < source.length && !isXmlSpace(source[cursor])) cursor += 1;
  const name = source.slice(nameStart, cursor);
  if (!XML_QNAME.test(name)) {
    throw pptxXmlSecurity("Invalid XML element name", "unsafe-xml", partName);
  }
  const attributes = new Map<string, string>();
  while (cursor < source.length) {
    if (!isXmlSpace(source[cursor])) {
      throw pptxXmlSecurity(
        "XML attributes must be separated by whitespace",
        "unsafe-xml",
        partName,
      );
    }
    skipSpace();
    if (cursor >= source.length) break;
    const attributeStart = cursor;
    while (cursor < source.length && !isXmlSpace(source[cursor]) && source[cursor] !== "=")
      cursor += 1;
    const attributeName = source.slice(attributeStart, cursor);
    if (!XML_QNAME.test(attributeName)) {
      throw pptxXmlSecurity("Invalid XML attribute name", "unsafe-xml", partName);
    }
    skipSpace();
    if (source[cursor] !== "=") {
      throw pptxXmlSecurity("XML attribute lacks a value", "unsafe-xml", partName);
    }
    cursor += 1;
    skipSpace();
    const quote = source[cursor];
    if (quote !== '"' && quote !== "'") {
      throw pptxXmlSecurity("XML attribute value must be quoted", "unsafe-xml", partName);
    }
    cursor += 1;
    const valueStart = cursor;
    const valueEnd = source.indexOf(quote, valueStart);
    if (valueEnd < 0) {
      throw pptxXmlSecurity("Unterminated XML attribute", "unsafe-xml", partName);
    }
    if (attributes.has(attributeName)) {
      throw pptxXmlSecurity("Duplicate XML attribute", "unsafe-xml", partName);
    }
    if (attributes.size >= maxAttributes) {
      throw pptxXmlLimit("XML element exceeds its attribute limit", partName);
    }
    const rawValue = source.slice(valueStart, valueEnd);
    if (rawValue.includes("<")) {
      throw pptxXmlSecurity(
        "XML attribute contains an unescaped less-than sign",
        "unsafe-xml",
        partName,
      );
    }
    attributes.set(attributeName, decodeEntities(rawValue, partName));
    cursor = valueEnd + 1;
  }
  return { type: "element", name, localName: xmlLocalName(name), attributes, children: [] };
}

function validateNamespaceBindings(
  element: PptxXmlElement,
  partName: string,
  inherited: ReadonlyMap<string, string>,
): void {
  const bindings = new Map(inherited);
  for (const [name, value] of element.attributes) {
    if (name === "xmlns") bindings.set("", value);
    else if (name.startsWith("xmlns:")) {
      const declaredPrefix = name.slice(6);
      const required = REQUIRED_NAMESPACE_URIS.get(declaredPrefix);
      if (required && required !== value) {
        throw pptxXmlSecurity(
          "OOXML namespace prefix is rebound to an unexpected URI",
          "unsafe-xml",
          partName,
        );
      }
      bindings.set(declaredPrefix, value);
    }
  }
  const prefix = xmlPrefix(element.name);
  if (prefix && !bindings.has(prefix)) {
    throw pptxXmlSecurity(
      "XML element uses an undeclared namespace prefix",
      "unsafe-xml",
      partName,
    );
  }
  const namespaceUri = bindings.get(prefix ?? "");
  if (namespaceUri === undefined) delete element.namespaceUri;
  else element.namespaceUri = namespaceUri;
  const attributeNamespaces = new Map<string, string | undefined>();
  for (const name of element.attributes.keys()) {
    if (name === "xmlns" || name.startsWith("xmlns:")) continue;
    const attributePrefix = xmlPrefix(name);
    if (attributePrefix && attributePrefix !== "xml" && !bindings.has(attributePrefix)) {
      throw pptxXmlSecurity(
        "XML attribute uses an undeclared namespace prefix",
        "unsafe-xml",
        partName,
      );
    }
    attributeNamespaces.set(
      name,
      attributePrefix === "xml"
        ? "http://www.w3.org/XML/1998/namespace"
        : attributePrefix
          ? bindings.get(attributePrefix)
          : undefined,
    );
  }
  element.attributeNamespaces = attributeNamespaces;
  for (const child of pptxXmlChildren(element))
    validateNamespaceBindings(child, partName, bindings);
}

function decodeEntities(value: string, partName: string): string {
  validateXmlCharacters(value, partName);
  if (value.includes("]]>")) {
    throw pptxXmlSecurity("XML contains malformed character data", "unsafe-xml", partName);
  }
  if (!value.includes("&")) return value;
  const output: string[] = [];
  let cursor = 0;
  let ampersand = value.indexOf("&");
  let references = 0;
  while (ampersand >= 0) {
    references += 1;
    if (references > 65_536) {
      throw pptxXmlLimit("XML text exceeds its entity reference limit", partName);
    }
    output.push(value.slice(cursor, ampersand));
    const semicolon = value.indexOf(";", ampersand + 1);
    const nested = value.indexOf("&", ampersand + 1);
    if (semicolon < 0 || (nested >= 0 && nested < semicolon)) {
      throw pptxXmlSecurity(
        "XML contains an unterminated entity reference",
        "unsafe-xml",
        partName,
      );
    }
    const entity = value.slice(ampersand + 1, semicolon);
    if (entity.length === 0 || entity.length > 16) {
      throw pptxXmlSecurity("XML contains a malformed entity reference", "unsafe-xml", partName);
    }
    output.push(decodeEntity(entity, partName));
    cursor = semicolon + 1;
    ampersand = value.indexOf("&", cursor);
  }
  output.push(value.slice(cursor));
  return output.join("");
}

function decodeEntity(entity: string, partName: string): string {
  if (entity === "amp") return "&";
  if (entity === "lt") return "<";
  if (entity === "gt") return ">";
  if (entity === "quot") return '"';
  if (entity === "apos") return "'";
  const decimal = /^#([0-9]+)$/.exec(entity);
  const hexadecimal = /^#x([0-9a-f]+)$/i.exec(entity);
  const codePoint = decimal
    ? Number(decimal[1])
    : hexadecimal
      ? Number.parseInt(hexadecimal[1] ?? "", 16)
      : NaN;
  if (!Number.isInteger(codePoint) || !isValidXmlCodePoint(codePoint)) {
    throw pptxXmlSecurity(`Unsupported or invalid XML entity: &${entity};`, "unsafe-xml", partName);
  }
  return String.fromCodePoint(codePoint);
}

function validateXmlCharacters(value: string, partName: string): void {
  for (const character of value) {
    if (!isValidXmlCodePoint(character.codePointAt(0) ?? 0)) {
      throw pptxXmlSecurity("XML contains a forbidden character", "unsafe-xml", partName);
    }
  }
}

function isValidXmlCodePoint(codePoint: number): boolean {
  return (
    codePoint === 0x09 ||
    codePoint === 0x0a ||
    codePoint === 0x0d ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff)
  );
}

export function pptxXmlChildren(element: PptxXmlElement | undefined): PptxXmlElement[] {
  return (
    element?.children.filter((child): child is PptxXmlElement => child.type === "element") ?? []
  );
}

export function pptxXmlChild(
  element: PptxXmlElement | undefined,
  localName: string,
): PptxXmlElement | undefined {
  return pptxXmlChildren(element).find((child) => child.localName === localName);
}

export function pptxXmlDescendants(
  element: PptxXmlElement | undefined,
  localName: string,
): PptxXmlElement[] {
  const output: PptxXmlElement[] = [];
  const visit = (node: PptxXmlElement): void => {
    for (const child of pptxXmlChildren(node)) {
      if (child.localName === localName) output.push(child);
      visit(child);
    }
  };
  if (element) visit(element);
  return output;
}

export function pptxXmlAttribute(
  element: PptxXmlElement | undefined,
  localName: string,
): string | undefined {
  if (!element) return undefined;
  for (const [name, value] of element.attributes) {
    if (xmlLocalName(name) === localName && name !== "xmlns" && !name.startsWith("xmlns:"))
      return value;
  }
  return undefined;
}

export function pptxXmlQualifiedAttribute(
  element: PptxXmlElement | undefined,
  qualifiedName: string,
): string | undefined {
  return element?.attributes.get(qualifiedName);
}

export function pptxXmlText(element: PptxXmlElement | undefined): string {
  if (!element) return "";
  let output = "";
  const visit = (node: PptxXmlNode): void => {
    if (node.type === "text") output += node.value;
    else for (const child of node.children) visit(child);
  };
  visit(element);
  return output;
}

export function pptxXmlDirectText(element: PptxXmlElement | undefined): string {
  return (
    element?.children
      .filter((child): child is { type: "text"; value: string } => child.type === "text")
      .map((child) => child.value)
      .join("") ?? ""
  );
}

export function pptxXmlSecurity(
  message: string,
  code: PresentationSecurityError["code"],
  entryName?: string,
): PresentationSecurityError {
  return new PresentationSecurityError(
    entryName ? `${message}: ${entryName}` : message,
    code,
    entryName,
  );
}

function pptxXmlLimit(message: string, entryName?: string): PresentationSecurityError {
  return pptxXmlSecurity(message, "limit-exceeded", entryName);
}

function xmlLocalName(value: string): string {
  return value.slice(value.indexOf(":") + 1);
}

function xmlPrefix(value: string): string | undefined {
  const index = value.indexOf(":");
  return index < 0 ? undefined : value.slice(0, index);
}

function isXmlSpace(value: string | undefined): boolean {
  return value === " " || value === "\t" || value === "\r" || value === "\n";
}

function isXmlWhitespace(value: string): boolean {
  for (const character of value) if (!isXmlSpace(character)) return false;
  return true;
}

const XML_QNAME = /^(?:[A-Za-z_][A-Za-z0-9_.-]*:)?[A-Za-z_][A-Za-z0-9_.-]*$/;

const REQUIRED_NAMESPACE_URIS = new Map([
  ["a", "http://schemas.openxmlformats.org/drawingml/2006/main"],
  ["c", "http://schemas.openxmlformats.org/drawingml/2006/chart"],
  ["p", "http://schemas.openxmlformats.org/presentationml/2006/main"],
  ["r", "http://schemas.openxmlformats.org/officeDocument/2006/relationships"],
]);
