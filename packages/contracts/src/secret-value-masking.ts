/**
 * Known-value secret masking: one deterministic engine for every place that
 * must not show a secret value it knows about (tool results, stored history
 * and events, browser and desktop observations, history scrubbing).
 *
 * A value is searched for in the forms it takes in text: as written, trimmed,
 * line by line, JSON-escaped (once and twice), percent-encoded (URI component,
 * `+` for spaces, form encoding) and, optionally, base64 (standard and
 * URL-safe, standalone and inside a longer base64 run). Each match is replaced
 * by the value's label, normally the reference that resolved it
 * (`{{secret:Vault/Item/field}}`), so whoever reads the text knows which secret
 * it was and can keep using it by reference.
 *
 * Properties:
 * - Values shorter than the minimum (8 characters by default) are never
 *   searched for: a short value such as a PIN would mangle unrelated text.
 * - A distinctive value (random-looking: a token, key or strong password) is
 *   searched for anywhere, in every form. A weak value (a word, a word with a
 *   few digits, a host, an email, a path, or a low-entropy string) also
 *   appears in unrelated names, paths and code, so it is replaced only as a
 *   whole token in a credential position: the whole line, after a
 *   credential word on the same line (`password=`, `"token": "…"`), or as a
 *   URL's password. See `secretValueStrength`.
 * - The longest form wins where several match at one position.
 * - Idempotent: the labels and Opengeni's markers already in the text are
 *   kept, so masking masked text changes nothing. Other reference-shaped text
 *   is searched like any text: a value inside it is still the value.
 * - A text that ends, or reaches a truncation mark (`...`, `…`), partway
 *   through a value has that clipped start replaced too, when the start is
 *   distinctive (at least 16 characters and half of the value).
 * - Pure and isomorphic: no I/O, no clock, no randomness.
 *
 * Labels must be safe inside JSON strings and URLs. `secretReferenceMaskLabel`
 * guarantees this for references; `secretCredentialMaskLabel` for Opengeni's
 * own credentials.
 */
import { credentialNameDescribesValue, credentialNameSaysSecret } from "./credential-names";
import { formatSecretReference, parseSecretReference } from "./secret-references";
import type { ResolvedSecretValue, SecretResolver } from "./secret-resolution";
import { isBase64DataUrl, isTextMediaType, mapSecretMaskableStrings } from "./secret-mask-strings";
import {
  collectSecretShapes,
  detectSecretShapes,
  maskSecretShapes,
  maskSecretShapesInText,
  secretShapeMaskLabel,
  type SecretShapeMatch,
} from "./secret-shape-masking";

export { isBase64DataUrl, isTextMediaType, mapSecretMaskableStrings };

/** Values shorter than this are not masked by default. Eight characters keeps
 * PINs, one-time codes, ports and short words out while still covering real
 * passwords, tokens and keys (which are almost always longer). */
export const SECRET_VALUE_MASK_MIN_CHARS = 8;

/** A text that ends (or reaches a truncation mark) partway through a value
 * has that clipped start masked only when it is distinctive: at least this
 * many characters... */
export const SECRET_VALUE_CLIPPED_MIN_CHARS = 16;
/** ...and at least this share of the value's form. A shared prefix (a URL
 * scheme, a token's fixed header, `-----BEGIN`) is never enough on its own. */
export const SECRET_VALUE_CLIPPED_MIN_SHARE = 0.5;

/** Distinct values one memory keeps; the oldest drop first. */
export const SECRET_VALUE_MEMORY_MAX_ENTRIES = 512;

export type SecretValueMaskEntry = {
  /** The plaintext to find. Never logged or returned by this module. */
  value: string;
  /** What replaces it: a reference or a fixed marker. Must be JSON- and URL-safe text. */
  label: string;
};

export type SecretValueMaskOptions = {
  /** Values (and derived forms) shorter than this are skipped. Default 8. */
  minChars?: number;
  /** Also search base64 forms. Default true. */
  base64?: boolean;
  /** Minimum characters for a clipped start (default 16, never below `minChars`). */
  clippedMinChars?: number;
  /** Minimum share of the form for a clipped start, 0 to 1 (default 0.5). */
  clippedMinShare?: number;
  /**
   * The end of a text counts as a cut only when the text has at least this
   * many characters (default 1,024: output clipped to a size). Truncation
   * marks always count.
   */
  clippedTextEndMinChars?: number;
  /**
   * Lines of a multi-line value searched on their own. "key-material"
   * (default): lines of at least 16 characters made only of base64 or hex
   * characters (PEM body lines), so a structured value's ordinary lines
   * (`NODE_ENV=production`) stay searchable text; "all": every line of at
   * least `minChars`.
   */
  lines?: "key-material" | "all";
  /**
   * Which forms are indexed for clipped starts. "primary" (default): the
   * value as written, trimmed and JSON-escaped once, which bounds memory for
   * long values. "all": every form, including lines and percent-encoded
   * forms (short typed values in browser and desktop results).
   */
  clippedForms?: "primary" | "all";
  /**
   * Object keys whose string values stay untouched (identifiers, digests).
   * Binary payloads are always skipped: a string that is entirely a base64
   * data URL (`data:<type>/<subtype>;base64,<base64>`) and the `data` of an
   * object that also carries a MIME type (image and file content). Payloads
   * of a text type are searched decoded and encoded again.
   */
  skipKey?: (key: string) => boolean;
  /**
   * A text that is a whole absolute address (`https://host:port/path`) keeps
   * its scheme, host and port: they name where the browser is, not text a
   * page or a person typed, and masking inside them leaves no usable address.
   * Its user info, path, query and fragment are masked as usual. Default false.
   */
  keepUrlHosts?: boolean;
  /**
   * Leave a tool's identity in conversation structure unmasked (see
   * SecretMaskableStringsOptions.keepToolIdentities). Default true, for
   * model input and stored conversation history. False where the structure
   * is data rather than conversation: tool output and browser or desktop
   * results, which are masked in full.
   */
  keepToolIdentities?: boolean;
  /**
   * Where weak values (see `secretValueStrength`) are replaced.
   * "credential-positions" (default): only in a credential position, so the
   * names, paths and code that merely contain them stay readable.
   * "anywhere": like distinctive values. For explicit, scoped removals: the
   * history scrub a person asked for, and values typed into one browser or
   * desktop session.
   */
  weakValues?: "credential-positions" | "anywhere";
  /**
   * Called for every candidate occurrence of a known value: replaced, or
   * (for a weak value outside a credential position) kept. Metadata only:
   * the event never carries text. Must not throw; errors are ignored.
   */
  onMatch?: (event: SecretValueMatchEvent) => void;
};

/** How a known value is searched for in text (see `secretValueStrength`). */
export type SecretValueStrength = "distinctive" | "weak";

/** Estimated entropy of a value, in bits (Shannon entropy of its characters times its length). */
export type SecretValueEntropyBucket = "lt32" | "32_64" | "64_128" | "ge128";

/** Where an occurrence sits in the text around it. */
export type SecretValueMatchPosition =
  /** A whole token: surrounded by spaces, quotes, `=`, `,` and the like. */
  | "token"
  /** Joined to letters, digits, `_` or `-` (part of an identifier or name). */
  | "identifier"
  /** Joined to `/` or `\`, or followed by a file extension (part of a path). */
  | "path"
  /** Inside a URL. */
  | "url"
  /** An encoded form (JSON-escaped, percent-encoded or base64). */
  | "encoded";

/** One occurrence of a known value; never carries the value or the text. */
export type SecretValueMatchEvent = {
  outcome: "masked" | "kept";
  strength: SecretValueStrength;
  entropy: SecretValueEntropyBucket;
  position: SecretValueMatchPosition;
  /** Occurrences with these labels in one masked text: one event per text, not per occurrence. */
  count: number;
};

export type SecretValueMaskDiagnostic = {
  /** Where masking failed, for example `tool_result` or `event_writer`. */
  stage: string;
  /** The error's class name only; never its message, which could carry text. */
  error: string;
};

/** The marker that replaces a credential Opengeni itself put into the attempt. */
const CREDENTIAL_LABEL_OPEN = "[opengeni credential: ";
/** How a `[masked <kind>]` marker (a shape value that has no reference) starts. */
const SHAPE_MARKER_OPEN = "[masked ";

export function secretCredentialMaskLabel(kind: string): string {
  const safe = kind.replace(/[^A-Za-z0-9 ._-]/gu, "").slice(0, 60) || "credential";
  return `${CREDENTIAL_LABEL_OPEN}${safe}]`;
}

/** Generic replacement when no usable reference exists. */
export const SECRET_VALUE_GENERIC_MASK_LABEL = "[secret]";

const REFERENCE_OPEN = "\u007B\u007Bsecret:";
const FILE_REFERENCE_OPEN = "\u007B\u007Bsecretfile:";
const JSON_UNSAFE = /["\\\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

/**
 * The label for a value a reference resolved to: the reference as written
 * (a `secretfile` reference is shown as the equivalent `secret` reference,
 * since what appears in text is the value, not the file path). A reference
 * whose text is unsafe inside JSON (a name with a quote) is written in its ID
 * form instead, which resolves to the same field.
 */
export function secretReferenceMaskLabel(input: {
  raw: string;
  itemId?: string | null;
  fieldName?: string | null;
}): string {
  let raw = input.raw;
  if (raw.startsWith(FILE_REFERENCE_OPEN)) {
    raw = REFERENCE_OPEN + raw.slice(FILE_REFERENCE_OPEN.length);
  }
  if (raw.startsWith(REFERENCE_OPEN) && !JSON_UNSAFE.test(raw)) return raw;
  if (input.itemId) {
    try {
      let previous = false;
      try {
        previous = parseSecretReference(raw).previous;
      } catch {
        previous = false;
      }
      const id = formatSecretReference({
        itemId: input.itemId,
        ...(input.fieldName ? { field: input.fieldName } : {}),
        ...(previous ? { previous: true } : {}),
      });
      if (!JSON_UNSAFE.test(id)) return id;
    } catch {
      // Fall through to the generic marker.
    }
  }
  return SECRET_VALUE_GENERIC_MASK_LABEL;
}

export function isSecretReferenceMaskLabel(label: string): boolean {
  return label.startsWith(REFERENCE_OPEN);
}

// ---------------------------------------------------------------------------
// Strength
// ---------------------------------------------------------------------------

/** Shannon entropy of the characters of `value`, times its length, in bits. */
export function secretValueEntropyBits(value: string): number {
  if (typeof value !== "string" || value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  const length = [...value].length;
  let perCharacter = 0;
  for (const count of counts.values()) {
    const share = count / length;
    perCharacter -= share * Math.log2(share);
  }
  return perCharacter * length;
}

function entropyBucket(bits: number): SecretValueEntropyBucket {
  if (bits < 32) return "lt32";
  if (bits < 64) return "32_64";
  if (bits < 128) return "64_128";
  return "ge128";
}

/**
 * A word cased as a word (lower case, Capitalized or ALL CAPS). A random run
 * of mixed-case letters is not one.
 */
const WORD = "(?:\\p{Ll}+|\\p{Lu}\\p{Ll}+|\\p{Lu}+)";
/** Up to four digits and one symbol after a word: `admin123`, `Password1!`. */
const WORD_TAIL = "[0-9]{0,4}[^\\p{L}\\p{N}\\s]?";
/** One word, or two separated by a single space, with an optional tail. */
const WORD_LIKE = new RegExp(`^${WORD}(?: ${WORD})?${WORD_TAIL}$`, "u");
/** A camelCase or PascalCase identifier: `adminUser`, `HarborView2`. */
const CAMEL_LIKE = new RegExp(
  `^(?:\\p{Ll}{2,}|\\p{Lu}\\p{Ll}{2,})(?:\\p{Lu}\\p{Ll}{2,})*${WORD_TAIL}$`,
  "u",
);
/** A part of a snake_case or kebab-case name: a word or a number. */
const SNAKE_PART = new RegExp(`^(?:${WORD}|[0-9]+)$`, "u");

/**
 * A snake_case or kebab-case name: two parts (`db_admin`, `deploy-bot`), or
 * three with a number among them (`deploy-bot-01`). Three or more words
 * (`wiry-unwound-cable`) are a passphrase.
 */
function snakeLike(text: string): boolean {
  const parts = text.split(/[_-]/u);
  if (parts.length < 2 || parts.length > 3 || !parts.every((part) => SNAKE_PART.test(part))) {
    return false;
  }
  return parts.length === 2 || parts.some((part) => /^[0-9]+$/u.test(part));
}
/** Values shaped like names of places, not secrets. */
const HOST_LIKE = /^(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?::\d{1,5})?$/u;
const EMAIL_LIKE = /^[^\s@]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}$/u;
const URL_LIKE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s@]+$/u;
const PATH_LIKE = /^(?:\/|\.{1,2}\/|~\/|[A-Za-z]:\\)\S*$/u;
/** Longer word-shaped values are treated as passphrases. */
const WORD_SHAPED_MAX_CHARS = 32;
/**
 * The 254 letter pairs that make up 95% of the pairs in the distinct English
 * words of Opengeni's documentation. A random run of letters has many pairs
 * outside this set (`qk`, `zv`, `xb`); words rarely do.
 */
const COMMON_LETTER_PAIRS = new Set(
  (
    "abacadagaiakalamanaparasatauavaybabebiblbobrbsbucacccechcickclcocrctcucydadbdcdddedi" +
    "dmdodrdsdueaebecedeeefegeielemeneoepeqereseteuevewexeyfafefffiflfofrfugageghgigngogr" +
    "gsguhahehihohtiaibicidieifigiliminioipirisitivizkekikslalcldlelilllolsltlulymambmemi" +
    "mmmompmsmunancndnenfngninknlnmnnnonpnrnsntnunvoaobocodofogoiokolomonoooporosotouovow" +
    "oxpapdpepiplpoppprpsptpuqurarcrdrergrirkrlrmrnrorrrsrtrurvrysascseshsiskslsospssstsu" +
    "tatctethtitltmtotptrtstttutyuaubucudueuiulumunupurusutvaveviwawewiwnwowsxcxexpxtypysz" +
    "aze"
  ).match(/../gu),
);
/**
 * The 2,402 letter triples that make up 95% of the triples in the same
 * words. Pairs alone let about one random run of single-case letters in a
 * hundred through; triples as well, about one in two thousand.
 */
const COMMON_LETTER_TRIPLES = new Set(
  (
    "abaabeabiablaboabrabsabuaccacdaceachaciackacoacqacractacyadaadbadcaddadeadfadiadjadl" +
    "admadoadradsadvadwadyafeaffaftagaageaggagiagnagraicaidailaimainairaisaitakeakiaksala" +
    "albalcaldalealfalgalialkallalmaloalpalralsaltalualvalwamaambameamiammampamsanaancand" +
    "aneanganiankanmannanoanransantanuanyapaapeaphapiappapsaptaraarbarcardareargariarkarl" +
    "armarnarrarsartaryasaascaseashasiaskasoassastasuasyataatcateatfathatiatlatoatsattatu" +
    "audaugaulaunausautavaaveaviavoawaawnaxeaxiaxsayeayiaylaymaysazubacbadbalbanbapbarbas" +
    "batbeabecbedbefbegbehbelbenberbesbhobidbigbilbinbitbjeblableblibloblybmiboabodboobor" +
    "botbouboxbrabrebribrobscbsebsobstbtrbufbuibunbusbutbyibypbytcabcaccadcalcamcancapcar" +
    "cascatcaucceccoccuceacebceccedceecefceicelcemcenceocepcercescetcevcewchachechichmcho" +
    "chpchrchschtchuciacidciecifcilcincipciscitckackbckcckeckfckgckicklcknckockpckscktcku" +
    "clacleclicloclucoacodcogcolcomconcoocopcorcoscoucovcpccpscptcpucqucracrecricrocrucry" +
    "ctactcctecthctictlctmctnctoctpctrctscttctuculcumcurcuscutcyccypdabdacdaedagdaldandap" +
    "dardasdatdaudaydbadbodbydcadcodcrddaddeddiddlddrdeadebdecdeddeedefdegdeldemdendeodep" +
    "derdesdetdevdexdfadfedfidfodfrdgediadicdiddiedifdigdindiodirdisditdivdjudledlidlydma" +
    "dmcdmedmidmodnodocdofdomdondopdordotdoudowdpadpedpodprdradredridrodsadscdsedshdsidsk" +
    "dstdsudtadtedthdtodtuduaducduldupdurdusdvadvedvidwoeabeaceadeafeageakealeameaneapear" +
    "easeateaueavebaebhebieboebpebrebsebuebyecaeceechecieckeclecoecrecsectecuecyedaedbedc" +
    "eddedeedfedgedhediedledmedoedpedredsedteduedweeceedeekeemeeneepeereeseeteeveexefaefe" +
    "effefieflefoefrefuegaegeegiegmegoegreguehaeheehoehteideigeineipeiteivejeekeekielaelc" +
    "eldeleelfelielleloelpelrelseltelyemaembemeemiemoempemsemuenaencendeneenfengenienoenr" +
    "ensentenuenveofeogeoneopeoreoueowepaepeephepieplepoeprepseptepuequeraerbercerdereerf" +
    "ergerherierlermerneroerperrerserteruerverweryesaesceseesfeshesieskeslesoespesqessest" +
    "esuesyetaetbetcetdeteetfetgethetietmetoetpetretsettetuetvetwetyeueeuneupeureusevaeve" +
    "evievoewaewceweewiewoewrewsexaexcexeexfexhexiexpexrexsexteyeeysfabfacfadfaifalfaufea" +
    "fecfedfeefenferfesfetffefffffifflffoffsficfiefigfilfinfirfitfixflafleflifloflufocfol" +
    "fooforfoufrafrefrofseftefulfunfusfycfyigacgaggaigangatgchgcogdegeagecgedgeegeggeigel" +
    "gemgengeogepgergesgetggegglghtgibgicgingisgitglegliglogmagmegnagnegnignognugoagoogor" +
    "gotgovgprgragregrigrogsegstgsugthguagueguigumgurhabhadhaihalhanhapharhashathauhavhbo" +
    "hclhcohdrheahechedheeheihelhemhenherheshexhichidhighilhinhiphishithivhmahmehnehoihol" +
    "homhonhoohorhoshothouhowhpahrahrehrohsehsthtehtmhtshtthubhumhunhwohydhypiabiagialian" +
    "iariatibeibiiblibribuicaiceichiciickicoicricsicticyidaidciddideidfidgidiidlidridsidt" +
    "iedielienieriesieviewifaifeiffifiiftifyigaigeiggighigiignigrigsiguiinikeilaildileili" +
    "illiloilsiltiluilyimaimeimiimmimpimsimuinainbincindineinfinginhiniinkinlinminninpins" +
    "intinuinvinwiodionioriosiouipaipeipiiplippipripsiptiquireiriirmiroirrirsirtisaiscise" +
    "isfishisiiskislismisoispisrissistisuitaitciteitfithitiitlitmitoitpitritsittituitwity" +
    "ivaiveiviiwoixeizaizeizijecjoijoujsojudjumjuskabkackagkbokcokdokedkeekenkepkerkesket" +
    "keykfikflkgrkilkinkipkitkloknokorkoukpokreksekspkstktiktokuplablaclailamlanlaplarlas" +
    "latlaulaylbalcalcolculdaldcldeldildoldrldslealeblecledleelefleglellemlenleplerleslet" +
    "leulevlewlexlfalfolialibliclidlielifligliklimlinlioliplislitlivlizllallbllcllellillm" +
    "llollpllrllslltllullylmelnaloaloblocloglonlooloplorloslotloulovlowloylpalpelpolprlre" +
    "lrolsclselsolstlsultaltelthltiltmltoltpltrltslualudlueluglumlunlurluslutlvalvelwolys" +
    "mabmacmagmaimalmanmapmarmasmatmaumaxmaymbembimblmcomcpmeamebmecmedmeemelmemmenmeomer" +
    "mesmetmevmicmidmigmilminmismitmizmmammemmimmommumodmonmormosmotmoumovmpampempimplmpo" +
    "mprmpsmptmpumulmupmutnabnacnadnagnainalnamnannapnarnasnatnaunavnbanbinblnboncancench" +
    "ncinclnconcrnctncuncyndandbndcndendindlndmndondpndrndsndtneanecnedneenegneinelnemnen" +
    "neonepnernesnetneunevnewnexnfanfenfinflnfonfrnfungangcngdngengfnghnginglngmngongpngr" +
    "ngsngtngunhenianicnidnienifnimninnionipnisnitniznkenkinksnlanlenlinlonlynmanmcnmenmo" +
    "nnannenninnonoanobnodnolnomnonnopnornosnotnounownpanpenplnponprnpunqunrenronrunsansc" +
    "nsensfnshnsinslnsonspnstnsunswntantbntcntdntentfnthntintlntmntontpntrntsnttntuntwnty" +
    "nuanuenuinulnumnupnurnusnvanvenvinvonwanwenwinwooadoaloaroasoauobaobeobjoblobsocaocc" +
    "oceociockocooctocuodaodeodiodsoduodyoesoffofioftogaogeoggogiognogoogrogsoicoidoinois" +
    "ojeokaokeokioksokuolaolbolcoldoleoliolloloolpolrolsoluolvomaombomcomeomiommomoompoms" +
    "onaonboncondoneonfongonhonionkonlonmonnonoonponronsontonuonvonwoodookooloomoopooroos" +
    "ootopaopdopeopioplopmopooppopropsoptopuopyoraorborcordoreorgoriorkorlormornoroorporr" +
    "orsortoruorworyosaoscoseosiosoospossostosuotaotcoteotfothotiotootsottouboudougouloun" +
    "oupourousoutovaoveoviowaowcowdoweowiowlownowsoxboxcoxeoxfoxioxsoxyoymozepabpacpadpag" +
    "paipalpanparpaspatpaupaypcapcopdapeapecpedpeepelpenperpespetpgrphaphephiphophrphypic" +
    "pidpiepiipikpilpinpippirpisplaplepliplopluplypocpoipolponpoopopporpospotpowppappeppi" +
    "pplppopprppsprepripropscpsepshpstptaptcpteptiptoptsptuptypubpulpurpusputquaquequiquo" +
    "rabracradrafragrairalramranraprarrasratrauravrawrbarbirborcarcerchrcirclrcorcurdardc" +
    "rderdirdrrdsrearebrecredreerefregrehreirejrelremrenreorepreqrerresretreurevrewrexrfa" +
    "rfirforgargergirgrrgurhoriaribricridrierifrigrimrinrioriprisritrivrizrkbrkdrkerkfrki" +
    "rksrlarlerlirlorlsrlyrmarmermirmormsrmurnarncrnernirnlrnornrrnsroarobrocrodrofrogroj" +
    "rokrolromronrooroprorrosrotrourovrowroxrparperplrporprrptrrarrerrirrorrursarscrsersh" +
    "rsirsorstrsurtartbrtcrterthrtirtmrtortrrtsrttrturtyrucrulrumrunruprusrutrvarvervirwa" +
    "rworyarycryeryirypryrryssabsacsafsagsalsamsansapsarsatsavscasceschscisclscoscrseasec" +
    "sedseesefsegseiselsemsensepseqsersessetseusevsfesfosgrshashcsheshishoshpshusibsicsid" +
    "sifsigsilsimsinsiosissitsivsizskaskeskiskssktslasleslislosluslysmasmismosnasocsofsol" +
    "somsonsorsouspaspespisplsposprsqlsqusressasscssessfssissksslssnssosspsstssusswstastb" +
    "stcstdstesthstistlstmstostpstrstssttstustwstysuasubsucsuesufsugsuisulsumsupsursusswa" +
    "sweswiswosymsynsystabtactadtagtaitaktaltamtantaptartastattautbatbetbitbotbrtbytcatch" +
    "tcltcotcrtcutdetdoteatebtectedteeteftegtehteitekteltemtenteoteptertestettevtewtextfa" +
    "tfitfotgrthathcthdthethfthithmthnthothrthsthuthwtiatibtictidtietiftigtiltimtintiotip" +
    "tirtistittivtiztketlatletlitlotlytmatmetmitmltmotmstnatnetnotoatoctoftogtoktoltomton" +
    "tootoptortostottoutovtowtpatpetpitpotprtputqutratretritrotrutrytsatsctsetsftshtsitsk" +
    "tsotsrtsttsuttattettittlttottpttrttuttytuatuntupturtustuttvatvitwatwetwitwotyctyityl" +
    "tymtyptyrtystyttyvtywuagualuanuaruatubaubjublubmubpubrubsubtuccuceuchuciuckuctudeudg" +
    "udiuedueiuenueruesueuuffuggughugiuiduieuiluinuiruisuitulaulduleullultumaumbumeummumn" +
    "umpunaunbuncunduneunfunguniunkunlunmunnunounpunrunsuntunwuotuouupaupcupdupeupgupiupl" +
    "uppupsupturaurcureurfurguriurlurnurpurrursurvusauseushusiusluspusrustutautbutcutdute" +
    "utfuthutiutlutmutoutputrutsuttvabvacvaivalvanvarvatvauveavecvedvefvelvemvenvepverves" +
    "vetvewviavicvidvievigvilvinviovirvisvitvivvocvoivokvolwaiwakwalwanwapwarwaswatwaywde" +
    "weawebwedweeweiwerweswhewhiwhowidwinwirwitwlewliwnewnlwnsworwrawriwsewstxacxaixamxap" +
    "xcaxcexchxclxcoxcrxecxedxerxesxflxhaxidximxinxisxitxpaxpexpixplxpoxprxrexsexsuxtaxte" +
    "xtrxtsxtuyabycayclycoydeydryedyeryexyfoyidyinyleyliyloymcymeymoynayncyntyouypaypeypo" +
    "ypryptyreyroyseysiysnystysuyteytoywaywozatzedzenzerzeszinzonzoozur"
  ).match(/.../gu),
);
/** At most one uncommon pair (or triple) in this many still reads as words. */
const GRAMS_PER_UNCOMMON_GRAM = 5;
const LENIENT_PAIR_SLACK = 2;
const LENIENT_TRIPLE_SLACK = 3;

/**
 * Whether a value's letters read as words: the letter pairs and triples
 * inside its words (camelCase and separators split words) are mostly common
 * English ones, so `pelican`, `harborMaster` and `deploy-bot` do and
 * `qkzvmxbtwe`, `rdabaootck`, `CruPjtBwrw` and `FXIOFWLOJA` do not. A word
 * that fails stays distinctive, which only masks it as before, and so does a
 * word with letters outside A to Z (`Müller`, Cyrillic), which the tables
 * cannot judge.
 *
 * In a host, URL or path, runs of fewer than four letters are skipped:
 * abbreviations such as `srv`, `npm` and `json` are common there.
 */
function readsAsWords(text: string, lenient = false): boolean {
  const runs = (text.match(/\p{Lu}?\p{Ll}+|\p{Lu}+/gu) ?? [])
    .filter((run) => run.length >= (lenient ? 4 : 3))
    .map((run) => run.toLowerCase());
  // Letters outside A to Z cannot be judged, so the value stays distinctive.
  if (runs.some((run) => !/^[a-z]+$/u.test(run))) return false;
  // Judged over all runs together, so a value cannot spread rare ones thinly.
  let pairs = 0;
  let uncommonPairs = 0;
  let triples = 0;
  let uncommonTriples = 0;
  for (const run of runs) {
    for (let index = 0; index + 1 < run.length; index += 1) {
      pairs += 1;
      if (!COMMON_LETTER_PAIRS.has(run.slice(index, index + 2))) uncommonPairs += 1;
      if (index + 2 < run.length) {
        triples += 1;
        if (!COMMON_LETTER_TRIPLES.has(run.slice(index, index + 3))) uncommonTriples += 1;
      }
    }
  }
  const pairSlack = lenient ? LENIENT_PAIR_SLACK : 0;
  const tripleSlack = lenient ? LENIENT_TRIPLE_SLACK : 0;
  return (
    uncommonPairs <= Math.floor((pairs + pairSlack) / GRAMS_PER_UNCOMMON_GRAM) &&
    uncommonTriples <= Math.floor((triples + tripleSlack) / GRAMS_PER_UNCOMMON_GRAM)
  );
}

/** A single word-shaped name: a word with a short tail, an identifier or a snake/kebab name. */
function wordShaped(text: string, lenient = false): boolean {
  if (text.length >= WORD_SHAPED_MAX_CHARS) return false;
  if (!(WORD_LIKE.test(text) || CAMEL_LIKE.test(text) || snakeLike(text))) return false;
  return readsAsWords(text, lenient);
}

/**
 * A host, email, URL or path is weak only when every part is a word-shaped
 * name or a number: `db.example.com:5432` is, `bR7.kQ2.mX9.Lp`, a webhook URL
 * or a path with a random segment carries a secret and is not.
 */
function partsAreWeak(text: string): boolean {
  // The scheme (`https`, `redis`) is not judged.
  const parts = text
    .replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u, "")
    .split(/[/\\?#&=:.@~]+/u)
    .filter((part) => part.length > 0);
  return parts.every((part) => /^[0-9]+$/u.test(part) || wordShaped(part, true));
}

/**
 * How a known value is searched for in text.
 *
 * Distinctive values (tokens, keys, random or strong passwords, passphrases
 * of three or more words) almost never appear in unrelated text, so they are
 * searched for anywhere, in every form. Weak values do appear in unrelated
 * text: a word or two with a few digits and a symbol (`admin123`,
 * `Password1!`), a camelCase or snake_case name, or a host, email, URL or
 * path made only of such names. Replacing them everywhere rewrites file
 * names, imports, hosts and identifiers that merely contain the word, so they
 * are replaced only in a credential position (see the module comment).
 * Digit-only values (card and account numbers) and values in a known token
 * format stay distinctive, however they read.
 */
export function secretValueStrength(value: string): SecretValueStrength {
  if (typeof value !== "string") return "weak";
  const text = value.trim();
  if (/^[0-9][0-9\s-]*$/u.test(text)) return "distinctive";
  // A value in a known token or key format is distinctive, however it reads.
  if (detectSecretShapes(text).some((shape) => shape.start === 0 && shape.end === text.length)) {
    return "distinctive";
  }
  if (/\s/u.test(text)) {
    return text.length < WORD_SHAPED_MAX_CHARS && WORD_LIKE.test(text) && readsAsWords(text)
      ? "weak"
      : "distinctive";
  }
  if (wordShaped(text)) return "weak";
  if (
    HOST_LIKE.test(text) ||
    EMAIL_LIKE.test(text) ||
    URL_LIKE.test(text) ||
    PATH_LIKE.test(text)
  ) {
    return partsAreWeak(text) ? "weak" : "distinctive";
  }
  return "distinctive";
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function utf8Bytes(value: string): Uint8Array | null {
  try {
    return new TextEncoder().encode(value);
  } catch {
    return null;
  }
}

function base64(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index]!;
    const b = index + 1 < bytes.length ? bytes[index + 1]! : 0;
    const c = index + 2 < bytes.length ? bytes[index + 2]! : 0;
    const triple = (a << 16) | (b << 8) | c;
    out += BASE64_ALPHABET[(triple >> 18) & 63]!;
    out += BASE64_ALPHABET[(triple >> 12) & 63]!;
    out += index + 1 < bytes.length ? BASE64_ALPHABET[(triple >> 6) & 63]! : "=";
    out += index + 2 < bytes.length ? BASE64_ALPHABET[triple & 63]! : "=";
  }
  return out;
}

/** Standalone base64 (padded and unpadded) and the part of the encoding that
 * depends only on the value at each of the three byte alignments a value can
 * have inside a longer base64 run (for example `user:token` in Basic auth). */
function base64Forms(value: string): string[] {
  const { standalone, inRun } = base64FormsByPlacement(value);
  return [...standalone, ...inRun];
}

/** `base64Forms`, split into the standalone encodings and the in-run parts. */
function base64FormsByPlacement(value: string): { standalone: string[]; inRun: string[] } {
  const bytes = utf8Bytes(value);
  if (bytes === null || bytes.length === 0) return { standalone: [], inRun: [] };
  const whole = base64(bytes);
  const standalone = [whole, whole.replace(/=+$/u, "")];
  const inRun: string[] = [];
  for (let offset = 0; offset < 3; offset += 1) {
    const padded = new Uint8Array(offset + bytes.length);
    padded.set(bytes, offset);
    const encoded = base64(padded);
    const start = Math.ceil((offset * 8) / 6);
    const end = Math.floor(((offset + bytes.length) * 8) / 6);
    if (end > start) inRun.push(encoded.slice(start, end));
  }
  const withUrlSafe = (forms: string[]) =>
    forms.flatMap((form) => [form, form.replaceAll("+", "-").replaceAll("/", "_")]);
  return { standalone: withUrlSafe(standalone), inRun: withUrlSafe(inRun) };
}

const PEM_BOUNDARY = /^-----(BEGIN|END) [A-Z0-9 ]+-----$/u;

/**
 * A line of key material (a PEM body line): pure hex, or base64 characters
 * with an upper-case letter, a lower-case letter and a digit. Not `NAME=value`
 * and not identifier-like lines such as `production-cluster-name`.
 */
const KEY_MATERIAL_LINE =
  /^(?:[0-9A-Fa-f]+|(?=[^\n]*[A-Z])(?=[^\n]*[a-z])(?=[^\n]*[0-9])[A-Za-z0-9+/_-]+={0,2})$/u;

/**
 * Every form of one value searched for in text, longest first. Forms shorter
 * than `minChars` are dropped; a value shorter than it has no forms.
 */
export function secretValueForms(value: string, options: SecretValueMaskOptions = {}): string[] {
  const minChars = options.minChars ?? SECRET_VALUE_MASK_MIN_CHARS;
  if (typeof value !== "string" || value.length < minChars) return [];
  const forms = new Set<string>();
  const add = (form: string | null | undefined) => {
    if (form && form.length >= minChars) forms.add(form);
  };
  add(value);
  // Tools trim the text they report and keep its first line, so a value's
  // trimmed form and each line of a multi-line value are searched too (but
  // not PEM boundary lines, which are the same in every key).
  add(value.trim());
  // By default only lines that look like key material (base64 or hex only,
  // at least 16 characters), so a structured value's ordinary lines
  // (`NODE_ENV=production`) stay searchable text.
  const lines = value.split(/\r?\n|\r/u);
  if (lines.length > 1) {
    for (const line of lines) {
      const trimmed = line.trim();
      if (PEM_BOUNDARY.test(trimmed)) continue;
      if (options.lines === "all" || (trimmed.length >= 16 && KEY_MATERIAL_LINE.test(trimmed))) {
        add(trimmed);
      }
    }
  }
  const escaped = JSON.stringify(value).slice(1, -1);
  add(escaped);
  add(JSON.stringify(escaped).slice(1, -1));
  try {
    const uri = encodeURIComponent(value);
    add(uri);
    add(uri.replaceAll("%20", "+"));
    add(uri.replace(/%[0-9A-F]{2}/gu, (match) => match.toLowerCase()));
  } catch {
    // A lone surrogate has no URI form; the raw value is still searched.
  }
  // Submitted forms and URLSearchParams encode more characters (for example
  // "!" as "%21") than encodeURIComponent does.
  try {
    add(new URLSearchParams({ v: value }).toString().slice(2));
  } catch {
    // Same as above.
  }
  if (options.base64 !== false) for (const form of base64Forms(value)) add(form);
  return [...forms].sort((left, right) => right.length - left.length);
}

// ---------------------------------------------------------------------------
// Compiled masks
// ---------------------------------------------------------------------------

/**
 * Markers that are never searched inside: Opengeni's own credential and
 * capture markers and the generic `[secret]`. A compiled set also keeps its
 * own labels exactly. Other reference-shaped text is searched like any text:
 * a value written inside reference syntax is still the value.
 */
const PROTECTED_PATTERNS = [
  "\\[opengeni credential: [A-Za-z0-9 ._-]{1,60}\\]",
  "\\[masked [a-z0-9 _-]{1,40}\\]",
  "\\[secret\\]",
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Where text may have been cut: its end, and each truncation mark a tool
 * leaves where it clipped a longer text before adding more after it. */
const TRUNCATION_MARK = /\.\.\.|\u2026/gu;

export type CompiledSecretValueMasks = {
  /** Known long numeric values, allowing only digit-grouping separators. */
  readonly formattedNumbers: ReadonlyArray<{ pattern: RegExp; label: string }>;
  readonly keepUrlHosts: boolean;
  readonly empty: boolean;
  readonly minChars: number;
  readonly skipKey: ((key: string) => boolean) | undefined;
  /** Labels and markers kept as they are; null when there is nothing to search for. */
  readonly pattern: RegExp | null;
  readonly labels: ReadonlyMap<string, string>;
  /** Forms longest first. */
  readonly forms: readonly string[];
  /** Forms by their first `minChars` characters, longest first. */
  readonly byPrefix: ReadonlyMap<string, readonly string[]>;
  /** The first two character codes of every form, as one number. */
  readonly firstPairs: ReadonlySet<number>;
  /** Clipped starts: at least this many characters... */
  readonly clippedMinChars: number;
  /** ...and at least this share of the form. */
  readonly clippedMinShare: number;
  /** The end of a text is a cut only for texts at least this long. */
  readonly clippedTextEndMinChars: number;
  /**
   * Clipped starts of forms by their last `clippedMinChars` characters,
   * longest first, so a cut needs one lookup.
   */
  readonly byClippedEnd: ReadonlyMap<string, readonly ClippedStart[]>;
  readonly longestForm: number;
  /**
   * Forms of weak values (see `secretValueStrength`), replaced only in a
   * credential position; every other form is replaced wherever it appears.
   */
  readonly weakForms: ReadonlyMap<string, WeakFormInfo>;
  /** Metadata about each form, for match events. */
  readonly formInfo: ReadonlyMap<string, FormInfo>;
  readonly onMatch: ((event: SecretValueMatchEvent) => void) | undefined;
};

type FormInfo = {
  strength: SecretValueStrength;
  entropy: SecretValueEntropyBucket;
  /** The form differs from the value as written or trimmed. */
  encoded: boolean;
};

type WeakFormInfo = {
  /**
   * A base64 form that appears inside a longer base64 run (a Basic auth
   * header), so it is never a whole token of its own.
   */
  inRun: boolean;
  /**
   * The whole base64 encoding of the value (a Kubernetes Secret's data): it
   * is replaced wherever it is a whole base64 run of its own, and inside a
   * longer run only as an in-run form is.
   */
  standalone: boolean;
};

/** A distinctive start of a form: `form.slice(0, length)`. */
type ClippedStart = { form: string; length: number };

/** Forms longer than this are not indexed for clipped starts (bounded memory). */
const CLIPPED_INDEX_MAX_FORM_CHARS = 8_192;
/**
 * Index entries for clipped starts across all values; once reached, the
 * remaining (longest) forms are matched whole only.
 */
const CLIPPED_INDEX_MAX_ENTRIES = 200_000;
/** Truncation marks examined per text, and candidates per mark. */
const CLIPPED_MAX_CUTS = 256;
const CLIPPED_MAX_CANDIDATES = 32;
/** The end of a text counts as a cut only for long texts (output clipped to a size). */
export const SECRET_VALUE_CLIPPED_TEXT_END_MIN_CHARS = 1_024;

/** Compile entries once for repeated masking. A form keeps the label of the first entry that has it. */
export function compileSecretValueMasks(
  entries: readonly SecretValueMaskEntry[],
  options: SecretValueMaskOptions = {},
): CompiledSecretValueMasks {
  const minChars = Math.max(2, options.minChars ?? SECRET_VALUE_MASK_MIN_CHARS);
  const clippedMinChars = Math.max(
    minChars,
    options.clippedMinChars ?? SECRET_VALUE_CLIPPED_MIN_CHARS,
  );
  const clippedMinShare = Math.min(
    1,
    Math.max(0, options.clippedMinShare ?? SECRET_VALUE_CLIPPED_MIN_SHARE),
  );
  const labels = new Map<string, string>();
  const formattedNumbers: Array<{ pattern: RegExp; label: string }> = [];
  const labelTexts = new Set<string>();
  // Clipped starts are indexed for the forms text usually shows (as written,
  // trimmed, JSON-escaped once), not the encoded variants.
  const clippable = new Set<string>();
  const formInfo = new Map<string, FormInfo>();
  const weakForms = new Map<string, WeakFormInfo>();
  // A form a distinctive value has is never treated as weak, even when a weak
  // value shares it.
  const distinctiveForms = new Set<string>();
  for (const entry of entries) {
    if (typeof entry?.value !== "string" || typeof entry.label !== "string") continue;
    const forms = secretValueForms(entry.value, { ...options, minChars });
    if (forms.length === 0) continue;
    // Payment widgets commonly insert grouping spaces (including nonbreaking
    // spaces) or hyphens. Match only the exact known digits, never arbitrary
    // numbers, and never apply this equivalence to passwords or other text.
    if (/^[0-9\s-]+$/u.test(entry.value)) {
      const digits = entry.value.replace(/[\s-]/gu, "");
      if (digits.length >= minChars && digits.length <= 19) {
        const separator = "(?:[\\s-]|%20|%C2%A0|%E2%80%(?:89|8A|AF)){0,4}";
        formattedNumbers.push({
          pattern: new RegExp(digits.split("").join(separator), "giu"),
          label: entry.label,
        });
      }
    }
    labelTexts.add(entry.label);
    for (const form of forms) if (!labels.has(form)) labels.set(form, entry.label);
    const strength = secretValueStrength(entry.value);
    const entropy = entropyBucket(secretValueEntropyBits(entry.value.trim()));
    const plain = new Set([entry.value, entry.value.trim()]);
    for (const form of forms) {
      const existing = formInfo.get(form);
      if (!existing || (existing.strength === "weak" && strength === "distinctive")) {
        formInfo.set(form, { strength, entropy, encoded: !plain.has(form) });
      }
    }
    if (strength === "distinctive" || options.weakValues === "anywhere") {
      for (const form of forms) {
        distinctiveForms.add(form);
        weakForms.delete(form);
      }
    } else {
      const placement =
        options.base64 === false
          ? { standalone: [], inRun: [] }
          : base64FormsByPlacement(entry.value);
      const standalone = new Set(placement.standalone);
      const inRun = new Set(placement.inRun);
      for (const form of forms) {
        if (distinctiveForms.has(form)) continue;
        weakForms.set(form, { inRun: inRun.has(form), standalone: standalone.has(form) });
      }
      // A weak value's start is not distinctive: clipped starts are not indexed.
      continue;
    }
    clippable.add(entry.value);
    clippable.add(entry.value.trim());
    clippable.add(JSON.stringify(entry.value).slice(1, -1));
  }
  const forms = [...labels.keys()].sort((left, right) => right.length - left.length);
  const byPrefix = new Map<string, string[]>();
  const byClippedEnd = new Map<string, ClippedStart[]>();
  const firstPairs = new Set<number>();
  for (const form of forms) {
    const prefix = form.slice(0, minChars);
    const bucket = byPrefix.get(prefix);
    if (bucket) bucket.push(form);
    else byPrefix.set(prefix, [form]);
    firstPairs.add(form.charCodeAt(0) * 65_536 + form.charCodeAt(1));
  }
  // Shortest forms first, so the global cap leaves out the longest values.
  let indexed = 0;
  for (let index = forms.length - 1; index >= 0; index -= 1) {
    const form = forms[index]!;
    if (weakForms.has(form)) continue;
    if (options.clippedForms !== "all" && !clippable.has(form)) continue;
    if (form.length <= clippedMinChars || form.length > CLIPPED_INDEX_MAX_FORM_CHARS) continue;
    const shortest = Math.max(clippedMinChars, Math.ceil(form.length * clippedMinShare));
    if (indexed + (form.length - shortest) > CLIPPED_INDEX_MAX_ENTRIES) break;
    for (let length = shortest; length < form.length; length += 1) {
      const key = form.slice(length - clippedMinChars, length);
      const starts = byClippedEnd.get(key);
      if (starts) starts.push({ form, length });
      else byClippedEnd.set(key, [{ form, length }]);
    }
    indexed += form.length - shortest;
  }
  for (const starts of byClippedEnd.values()) {
    starts.sort((left, right) => right.length - left.length);
  }
  const pattern =
    forms.length === 0
      ? null
      : new RegExp(
          [
            ...[...labelTexts].sort((left, right) => right.length - left.length).map(escapeRegExp),
            ...PROTECTED_PATTERNS,
          ]
            .map((source) => `(?:${source})`)
            .join("|"),
          "gu",
        );
  return {
    formattedNumbers,
    keepUrlHosts: options.keepUrlHosts === true,
    empty: forms.length === 0,
    minChars,
    skipKey: options.skipKey,
    pattern,
    labels,
    forms,
    byPrefix,
    firstPairs,
    clippedMinChars,
    clippedMinShare,
    clippedTextEndMinChars: Math.max(
      0,
      options.clippedTextEndMinChars ?? SECRET_VALUE_CLIPPED_TEXT_END_MIN_CHARS,
    ),
    byClippedEnd,
    longestForm: forms[0]?.length ?? 0,
    weakForms,
    formInfo,
    onMatch: options.onMatch,
  };
}

/**
 * The longest start of a form that `text` ends with at `cut` (text clipped to
 * a length can end partway through a value, and that partial value is still
 * the secret's start). Only distinctive starts count: at least
 * `clippedMinChars` characters and `clippedMinShare` of the form, so a
 * shared prefix such as a URL scheme or a token's fixed header is not one.
 */
function clippedSecretTail(
  text: string,
  cut: number,
  masks: CompiledSecretValueMasks,
): { length: number; label: string; form: string } | null {
  const probe = masks.clippedMinChars;
  if (cut < probe || masks.byClippedEnd.size === 0) return null;
  const candidates = masks.byClippedEnd.get(text.slice(cut - probe, cut));
  if (!candidates) return null;
  // Longest first: the longest clipped value wins.
  let checked = 0;
  for (const { form, length } of candidates) {
    if (length > cut) continue;
    if (checked++ >= CLIPPED_MAX_CANDIDATES) break;
    if (!text.startsWith(form.slice(0, length), cut - length)) continue;
    const label = masks.labels.get(form);
    if (label !== undefined) return { length, label, form };
  }
  return null;
}

function overlapsKept(start: number, end: number, kept: ReadonlyArray<[number, number]>): boolean {
  for (const [from, to] of kept) if (start < to && from < end) return true;
  return false;
}

function keptRanges(text: string, pattern: RegExp): Array<[number, number]> {
  const kept: Array<[number, number]> = [];
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    if (match[0].length > 0) kept.push([match.index, match.index + match[0].length]);
  }
  return kept;
}

/** An absolute address: scheme, optional user info (up to the authority's
 * last `@`, so a password containing one is all user info), host and port,
 * then the rest. */
const ABSOLUTE_URL = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)(?:([^/?#\s]*)@)?([^/?#@\s]*)([^\s]*)$/u;

// ---------------------------------------------------------------------------
// Weak values: credential positions only
// ---------------------------------------------------------------------------

/**
 * Characters that join a weak value to the text around it, so that it is part
 * of a longer name: an identifier, a path, a host, an email or a file name.
 * `:` joins only before a `/` or a digit (a URL scheme, a port, an image
 * tag); trailing sentence punctuation does not join.
 */
const JOINING_CHARACTER = /[\p{L}\p{N}\p{M}_\-./\\+~%@]/u;
const TRAILING_PUNCTUATION = /[.,;:!?]/u;
const AFTER_TRAILING_PUNCTUATION = /[\s"'`)\]}>\\]/u;
/**
 * A credential word before a base64 run (`Authorization: Basic …`): the
 * encoded value inside the run is replaced. The word ends where a lower-case
 * letter does not continue it, so `PGPASSWORD` and `apiKey` count and
 * `--author` and `keyboard` do not.
 */
const CREDENTIAL_CONTEXT =
  /pass(?:words?|wd|phrases?|codes?)?|pwd|secrets?|tokens?|keys?|auth(?:orization|entication)?|credentials?|creds|bearer/giu;
function hasCredentialWord(text: string): boolean {
  CREDENTIAL_CONTEXT.lastIndex = 0;
  for (const match of text.matchAll(CREDENTIAL_CONTEXT)) {
    const next = text[match.index + match[0].length];
    if (next === undefined || !/[a-z]/u.test(next)) return true;
  }
  return false;
}

/*
 * Names that lead into a weak value. Each pattern ends where the value
 * starts, and its first group is the name, checked word by word with
 * `credentialNameSaysSecret`. A quote may be JSON-escaped (`\"`).
 */
const Q = `(?:\\\\?["'])?`;
const NAME = "([A-Za-z0-9_.$@-]*[A-Za-z0-9])";
/** `password=…`, `"token": "…"`, `DB_PASS="…"`, `Password=…;`, `apiKey := …`, `secret => …`. */
const ASSIGNED = new RegExp(`${NAME}${Q}\\s*(?:=>|:=|[:=])\\s*${Q}$`, "u");
/** `--password …`, `--db-password=…`, `-token …`. */
const OPTION = new RegExp(`(?:^|[\\s"'])--?([A-Za-z][A-Za-z0-9_.-]*)(?:\\s+|=)${Q}$`, "u");
/** "the password is …", "token was: …". */
const STATED = new RegExp(`${NAME}${Q}\\s+(?:is|was)(?:\\s*:)?\\s+${Q}$`, "iu");
/** A password word right before the value: `password …` (netrc), `requirepass …`, `with passphrase …`. */
const PASSWORD_WORD = new RegExp(
  `(?:^|[\\s"'\`(])([A-Za-z0-9_.-]*(?:pass(?:word|wd|phrase|code)?|pwd))\\s+${Q}$`,
  "iu",
);
/** Nothing but a closing quote, punctuation or a comment before the end of the line. */
const LINE_ENDS = /^["'`]?[;,]?\s*(?:#.*)?$/u;
/** A netrc entry: `machine host login user password …`. */
const NETRC_LINE = /(?:^|\s)(?:machine|default)\s+\S+.*\s(?:login|password)\s/u;
/** A config directive at the start of its line: `masterauth …`. */
const DIRECTIVE = new RegExp(`^\\s*([A-Za-z][A-Za-z0-9_.-]*auth)\\s+${Q}$`, "iu");
/** `Authorization: Bearer …`, `auth: token …`, a bare `Bearer …`. */
const AUTH_SCHEME = new RegExp(
  `(?:(?:authorization|auth)${Q}\\s*[:=]\\s*${Q}(?:bearer|token|basic)|(?:^|[\\s"'(])bearer)\\s+$`,
  "iu",
);
/** `Cookie: sid=…`, `Set-Cookie: a=b; sid=…`. */
const COOKIE = /(?:^|[\s"'])(?:set-)?cookie["']?\s*:\s*(?:[^\s;=]+=[^\s;]*;\s*)*[^\s;=]+=$/iu;

/**
 * Programs whose options take a password: `mysql -p…` (attached),
 * `sshpass -p …`, `redis-cli -a …`, `curl -u user:…`, `htpasswd -b file user …`.
 * Elsewhere `-p`, `-a` and `-u` mean other things (`mkdir -p`, `ls -a`).
 */
const ATTACHED_P_PROGRAM =
  /(?:^|[\s/"'`(])(?:mysql|mariadb|mysqladmin|mysqldump|mysqlsh|sshpass|7z|7za|7zz|7zr)\s/u;
const SPACED_P_PROGRAM =
  /(?:^|[\s/"'`(])(?:sshpass|(?:docker|podman|nerdctl|oc|az)\s+login|mongo(?:sh|dump|restore|export|import|stat|top|files)?)\s/u;
const A_PROGRAM = /(?:^|[\s/"'`(])(?:redis-cli|keydb-cli)\s/u;
const U_PROGRAM = /(?:^|[\s/"'`(])curl\s/u;
const W_PROGRAM =
  /(?:^|[\s/"'`(])ldap(?:search|add|modify|delete|modrdn|compare|passwd|whoami|exop)\s/u;
const CAPITAL_P_PROGRAM = /(?:^|[\s/"'`(])(?:sqlcmd|bcp|zip|unzip)\s/u;
/** `smbclient -U user%…`: the password follows a `%`. */
const PERCENT_USER =
  /(?:^|[\s/"'`(])(?:smbclient|rpcclient|smbcacls|smbget)\s(?:.*\s)?(?:-U\s*|--user[=\s])["']?[^\s%"']+%$/u;
const ATTACHED_P = /(?:^|\s)-p$/u;
const SPACED_P = /(?:^|\s)-p\s+["']?$/u;
const SPACED_A = /(?:^|\s)-a\s+["']?$/u;
const SPACED_W = /(?:^|\s)-w\s+["']?$/u;
const SPACED_CAPITAL_P = /(?:^|\s)-P\s+["']?$/u;
const USER_COLON = /(?:^|\s)(?:-u|--user)(?:\s+|=)["']?[^\s:"']+:$/u;
const HTPASSWD = /(?:^|[\s/"'`(])htpasswd\s+-\w*b\w*\s+\S+\s+\S+\s+["']?$/u;

/** The current command of a shell line: after the last `|`, `;`, `&&` or `||`. */
function commandSegment(before: string): string {
  const parts = before.split(/\|\||&&|[|;]/u);
  return parts[parts.length - 1] ?? "";
}

/** Text that may hold a credential name (a cheap test before the patterns). */
const MAY_NAME_CREDENTIAL =
  /pass|pwd|pw|secret|token|key|auth|cred|bearer|session|cookie|private|signature|jwt/iu;
/** Text that may hold a password option. */
const MAY_HOLD_OPTION = /-[pauwP]|--user|htpasswd/u;

/** `<password>…`, `<ns:Secret type="x">…` (the closing tag follows the value). */
const XML_ELEMENT = /<([A-Za-z_][\w.:-]*)(?:\s[^<>]*)?>$/u;
/** `<add key="Password" value="…" />` (.NET configuration). */
const XML_KEY_VALUE = new RegExp(
  `\\bkey\\s*=\\s*${Q}([^"'<>\\\\]+)${Q}\\s+value\\s*=\\s*${Q}$`,
  "iu",
);
/** SQL `IDENTIFIED BY '…'`, `IDENTIFIED WITH mysql_native_password BY '…'`. */
const IDENTIFIED_BY = /\bidentified\s+(?:with\s+\S+\s+)?by\s+(?:password\s+)?["']?$/iu;
/** A `.pgpass` line, whose last field is the password: `host:5432:db:user:…`. */
const PGPASS_LINE = /^\s*[^\s:#]+:(?:[0-9]+|\*):[^\s:]+:[^\s:]+:$/u;
/** Before an assignment, a name in a ternary (`? "a" :`) or after a `/` (`@scope/pkg":`) is not a key. */
const NOT_A_KEY_BEFORE = /(?:\s\?\s+(?:\\?["'])?|\/)$/u;

function nameLeadsIn(before: string, after: string): boolean {
  if (IDENTIFIED_BY.test(before)) return true;
  if (!MAY_NAME_CREDENTIAL.test(before)) return false;
  const assigned = ASSIGNED.exec(before);
  if (
    assigned?.[1] !== undefined &&
    !NOT_A_KEY_BEFORE.test(before.slice(0, assigned.index)) &&
    credentialNameSaysSecret(assigned[1])
  ) {
    return true;
  }
  for (const pattern of [OPTION, STATED, XML_KEY_VALUE]) {
    const name = pattern.exec(before)?.[1];
    if (name !== undefined && credentialNameSaysSecret(name)) return true;
  }
  // `password …` without `=` or `:` is a config line (`requirepass …`) or a
  // netrc entry, not prose ("the password database"): the value ends the line,
  // or the line is a netrc entry.
  const word = PASSWORD_WORD.exec(before)?.[1];
  if (
    word !== undefined &&
    credentialNameSaysSecret(word) &&
    (LINE_ENDS.test(after) || NETRC_LINE.test(before))
  ) {
    return true;
  }
  const element = XML_ELEMENT.exec(before)?.[1];
  if (element !== undefined && after.startsWith("</") && credentialNameSaysSecret(element)) {
    return true;
  }
  return DIRECTIVE.test(before) || AUTH_SCHEME.test(before) || COOKIE.test(before);
}

function passwordOption(before: string): boolean {
  if (!MAY_HOLD_OPTION.test(before)) return false;
  const command = commandSegment(before);
  if (SPACED_P.test(command)) return SPACED_P_PROGRAM.test(command);
  if (SPACED_A.test(command)) return A_PROGRAM.test(command);
  if (SPACED_W.test(command)) return W_PROGRAM.test(command);
  if (SPACED_CAPITAL_P.test(command)) return CAPITAL_P_PROGRAM.test(command);
  if (USER_COLON.test(command)) return U_PROGRAM.test(command);
  return HTPASSWD.test(command);
}

/** `echo …`, `printf '%s' …`: the value is what a command prints. */
const PRINTED =
  /(?:^|[\s;&|(])(?:echo|printf)(?:\s+-[A-Za-z]+)*(?:\s+(["'])%s(?:\\n)?\1)?\s+["']?(?:[^\s:"']+:)?$/u;
/** A single pipe after the value, and the next command up to a comment or another command. */
const PIPED_INTO = /^["']?[ \t]*\|(?!\|)([^#;|&]*)/u;
/** `sudo -S` reads its password from standard input. */
const SUDO_STDIN = /(?:^|\s)sudo\s+(?:-\w*S\w*)/u;

/**
 * Printed into a command that reads a password, whose name or options say so:
 * `echo '…' | docker login --password-stdin`, `echo 'app:…' | chpasswd`,
 * `echo … | sudo -S true`.
 */
function pipedToPasswordReader(before: string, after: string): boolean {
  if (!PRINTED.test(before)) return false;
  const next = PIPED_INTO.exec(after)?.[1];
  if (next === undefined) return false;
  if (SUDO_STDIN.test(next)) return true;
  // The program (and its subcommand) and the option names, not arguments:
  // `| grep token` and `| tee password-notes.txt` do not read a password.
  const words = next.trim().split(/\s+/u);
  return words.some((word, index) => {
    const name = word.replace(/^["']|["']$/gu, "");
    if (name.startsWith("-"))
      return credentialNameSaysSecret(name.replace(/^-+/u, "").split("=")[0]!);
    return index === 0 && credentialNameSaysSecret(name.split("/").pop()!);
  });
}

/** A line that is only a key before the value: `value: …`, `- admin: …`, `"value": "…`. */
const KEY_ONLY_LINE = new RegExp(`^\\s*(?:-\\s+)?${Q}([\\w.-]+)${Q}\\s*[:=]\\s*${Q}$`, "u");
/** `- name: DB_PASSWORD`, `"name": "DB_PASSWORD",`, `key: api-token`. */
const NAMED_ENTRY_LINE = new RegExp(
  `^\\s*(?:-\\s+)?${Q}(?:name|key)${Q}\\s*:\\s*${Q}([\\w.-]+)${Q}\\s*,?\\s*$`,
  "u",
);
/** `credentials:`, `"secrets": {`. */
const SECTION_LINE = new RegExp(`^\\s*(?:-\\s+)?${Q}([\\w.-]+)${Q}\\s*:\\s*\\{?\\s*$`, "u");
/** Characters before a weak value searched for a credential word or a line start. */
const CREDENTIAL_CONTEXT_CHARS = 80;
/** The longest key line (`  value: `) searched before a weak value. */
const KEY_LINE_MAX_CHARS = 120;
const LINE_SCAN_CHARS = 400;

/** An escape sequence for a line break, tab or quote in JSON-escaped text ends at `at`. */
function escapeEndsAt(text: string, at: number): boolean {
  return at >= 2 && text[at - 2] === "\\" && /[nrt"]/u.test(text[at - 1]!) && text[at - 3] !== "\\";
}

function boundaryBefore(text: string, start: number): boolean {
  if (start === 0) return true;
  if (escapeEndsAt(text, start)) return true;
  return !JOINING_CHARACTER.test(text[start - 1]!);
}

function boundaryAfter(text: string, end: number): boolean {
  if (end >= text.length) return true;
  const next = text[end]!;
  // Separators of connection strings, lists and query strings:
  // `Password=…;Database=app`, `PWD=…;UID=sa`, `password=…&user=app`.
  if (next === ";" || next === "," || next === "&") return true;
  if (next === "\\") return /[nrt"]/u.test(text[end + 1] ?? "");
  if (next === ":") return !/[/\\0-9]/u.test(text[end + 1] ?? "");
  if (TRAILING_PUNCTUATION.test(next)) {
    const after = text[end + 1];
    return after === undefined || AFTER_TRAILING_PUNCTUATION.test(after);
  }
  return !JOINING_CHARACTER.test(next);
}

/**
 * How a line starts before `start` (spaces and tabs skipped): a real or
 * escaped line break (or the start of the text), the opening quote of a JSON
 * string value, or neither.
 */
function lineStartBefore(text: string, start: number): "break" | "quote" | null {
  let at = start;
  while (at > 0 && (text[at - 1] === " " || text[at - 1] === "\t")) at -= 1;
  if (at === 0) return "break";
  const previous = text[at - 1]!;
  if (previous === "\n" || previous === "\r") return "break";
  if (escapeEndsAt(text, at) && (previous === "n" || previous === "r")) return "break";
  if (previous === '"' && /[:[,{]\s*$/u.test(text.slice(Math.max(0, at - 9), at - 1))) {
    return "quote";
  }
  return null;
}

function lineEndAfter(text: string, end: number): "break" | "quote" | null {
  let at = end;
  while (at < text.length && (text[at] === " " || text[at] === "\t")) at += 1;
  if (at >= text.length) return "break";
  const next = text[at]!;
  if (next === "\n" || next === "\r") return "break";
  if (next === "\\" && /[nr]/u.test(text[at + 1] ?? "")) return "break";
  if (next === '"' || (next === "\\" && text[at + 1] === '"')) return "quote";
  return null;
}

/** Where the line holding `start` begins, at most `LINE_SCAN_CHARS` back. */
function lineStartIndex(text: string, start: number, limit = LINE_SCAN_CHARS): number {
  const floor = Math.max(0, start - limit);
  for (let at = start; at > floor; at -= 1) {
    const previous = text[at - 1]!;
    if (previous === "\n" || previous === "\r") return at;
    if (escapeEndsAt(text, at) && (previous === "n" || previous === "r")) return at;
  }
  return floor;
}

/** Where the line holding `end` ends, at most `LINE_SCAN_CHARS` on. */
function lineEndIndex(text: string, end: number, limit = LINE_SCAN_CHARS): number {
  const ceiling = Math.min(text.length, end + limit);
  for (let at = end; at < ceiling; at += 1) {
    const next = text[at]!;
    if (next === "\n" || next === "\r") return at;
    if (next === "\\" && /[nr]/u.test(text[at + 1] ?? "") && text[at - 1] !== "\\") return at;
  }
  return ceiling;
}

/** Where the line before the one starting at `lineStart` begins, or `null` at the text start. */
function previousLineStartIndex(text: string, lineStart: number): number | null {
  let at = lineStart;
  if (at === 0) return null;
  if (text[at - 1] === "\n") at -= 1;
  if (text[at - 1] === "\r") at -= 1;
  if (at === lineStart && escapeEndsAt(text, at)) at -= 2;
  if (at === lineStart) return null;
  return lineStartIndex(text, at);
}

/** `scheme://user:` (or `scheme://:`) ends just before `start`, and `@` follows `end`. */
function inUrlPasswordPosition(text: string, start: number, end: number): boolean {
  if (text[start - 1] !== ":" || text[end] !== "@") return false;
  const before = text.slice(Math.max(0, start - 1 - 256), start - 1);
  return /[A-Za-z][A-Za-z0-9+.-]*:(?:\\?\/){2}[^\s/@:"'\\]*$/u.test(before);
}

/**
 * Whether a weak value at `start…end` is in a credential position: the
 * whole line (or the whole text), a URL's password, or a whole token that a
 * credential name leads into (`password=…`, `"token": "…"`, `--password …`,
 * "the password is …", `Authorization: Bearer …`, `<password>…`,
 * `IDENTIFIED BY '…'`), a password option of a program that takes one
 * (`mysql -p…`, `docker login -p …`, `smbclient -U user%…`, `curl -u
 * user:…`), the last field of a `.pgpass` line, printed into a command that
 * reads a password, or the value of a key on a line after one that names a
 * credential (`- name: DB_PASSWORD` then `value: …`). A base64 form inside a longer run (a Basic auth header)
 * needs only a credential word earlier on the line.
 */
const BASE64_CHARACTER = /[A-Za-z0-9+/_=-]/u;

function weakValuePositionAllowed(
  text: string,
  start: number,
  end: number,
  form: WeakFormInfo,
): boolean {
  // The whole base64 encoding of the value, as a run of its own: someone
  // encoded exactly that value (a Kubernetes Secret's data).
  if (
    form.standalone &&
    !BASE64_CHARACTER.test(text[start - 1] ?? "") &&
    !BASE64_CHARACTER.test(text[end] ?? "")
  ) {
    return true;
  }
  const inRun = form.inRun || form.standalone;
  const left = lineStartBefore(text, start);
  const right = left === null ? null : lineEndAfter(text, end);
  if (left !== null && right !== null && !(left === "quote" && right === "quote")) return true;
  if (inUrlPasswordPosition(text, start, end)) return true;
  // Cheap boundary checks first, before any line is scanned.
  // `mysql -p…`, `smbclient -U user%…`: the value is attached to the option.
  const attachedOption =
    !inRun && ((text[start - 1] === "p" && text[start - 2] === "-") || text[start - 1] === "%");
  if (!inRun && !boundaryAfter(text, end)) return false;
  if (!inRun && !attachedOption && !boundaryBefore(text, start)) return false;
  // A line longer than this before the value is not a key line.
  const lineStart = lineStartIndex(text, start, KEY_LINE_MAX_CHARS);
  const before = text.slice(Math.max(lineStart, start - CREDENTIAL_CONTEXT_CHARS), start);
  if (inRun) return hasCredentialWord(before);
  if (attachedOption) {
    const command = commandSegment(before);
    if (text[start - 1] === "%") return PERCENT_USER.test(command);
    return ATTACHED_P.test(command) && ATTACHED_P_PROGRAM.test(command);
  }
  const after = text.slice(end, lineEndIndex(text, end, CREDENTIAL_CONTEXT_CHARS));
  if (nameLeadsIn(before, after) || passwordOption(before)) return true;
  if (pipedToPasswordReader(before, after)) return true;
  if (lineStart === start - KEY_LINE_MAX_CHARS) return false;
  if (lineEndAfter(text, end) === "break" && PGPASS_LINE.test(text.slice(lineStart, start))) {
    return true;
  }
  const key = KEY_ONLY_LINE.exec(text.slice(lineStart, start))?.[1];
  if (key === undefined || credentialNameDescribesValue(key)) return false;
  const previousStart = previousLineStartIndex(text, lineStart);
  if (previousStart === null) return false;
  const previous = text.slice(previousStart, lineStart).replace(/(?:\\[nr]|[\r\n])+$/u, "");
  const named = NAMED_ENTRY_LINE.exec(previous)?.[1] ?? SECTION_LINE.exec(previous)?.[1];
  return named !== undefined && credentialNameSaysSecret(named);
}

const RUN_BREAK = /[\s"'`<>()[\]{}]/u;

/**
 * Where the run of non-space characters before a position starts, and the
 * last `://` (or JSON-escaped `:\/\/`) in the text before it. Read forward
 * once per text, so counting every occurrence stays linear.
 */
type RunCursor = { text: string; scanned: number; lastBreak: number; lastScheme: number };

function runCursor(text: string): RunCursor {
  return { text, scanned: 0, lastBreak: -1, lastScheme: -1 };
}

/** Whether the run before `start` holds a URL scheme. */
function runHasScheme(cursor: RunCursor, start: number): boolean {
  const { text } = cursor;
  if (start < cursor.scanned) {
    // Out of order (a clipped tail): read the run backwards, at most 64 characters.
    const floor = Math.max(0, start - 64);
    let runStart = start;
    while (runStart > floor && !RUN_BREAK.test(text[runStart - 1]!)) runStart -= 1;
    const run = text.slice(runStart, start);
    return run.includes("://") || run.includes(":\\/\\/");
  }
  for (let at = cursor.scanned; at < start; at += 1) {
    const code = text.charCodeAt(at);
    if (RUN_BREAK.test(text[at]!)) cursor.lastBreak = at;
    else if (
      code === 58 &&
      (text.startsWith("//", at + 1) || text.startsWith("\\/\\/", at + 1)) &&
      at + 3 <= start
    ) {
      cursor.lastScheme = at;
    }
  }
  cursor.scanned = start;
  return cursor.lastScheme > cursor.lastBreak;
}

function matchPosition(
  cursor: RunCursor,
  start: number,
  end: number,
  encoded: boolean,
): SecretValueMatchPosition {
  if (encoded) return "encoded";
  const { text } = cursor;
  if (runHasScheme(cursor, start)) return "url";
  const previous = text[start - 1] ?? "";
  const next = text[end] ?? "";
  if (previous === "/" || previous === "\\" || next === "/" || next === "\\") return "path";
  if (next === "." && /[A-Za-z0-9]/u.test(text[end + 1] ?? "")) return "path";
  if (/[\p{L}\p{N}_-]/u.test(previous) || /[\p{L}\p{N}_-]/u.test(next)) return "identifier";
  return "token";
}

/** Match events of one masked text, by their labels, and where its runs start. */
type MatchTally = { events: Map<string, SecretValueMatchEvent>; cursor: RunCursor | null };

function reportMatch(
  masks: CompiledSecretValueMasks,
  tally: MatchTally | null,
  form: string,
  outcome: SecretValueMatchEvent["outcome"],
  text: string,
  start: number,
): void {
  if (tally === null) return;
  try {
    const info = masks.formInfo.get(form);
    const strength = info?.strength ?? "distinctive";
    const entropy = info?.entropy ?? "ge128";
    if (tally.cursor?.text !== text) tally.cursor = runCursor(text);
    const position = matchPosition(
      tally.cursor,
      start,
      start + form.length,
      info?.encoded === true,
    );
    const key = `${outcome} ${strength} ${entropy} ${position}`;
    const counted = tally.events.get(key);
    if (counted) counted.count += 1;
    else tally.events.set(key, { outcome, strength, entropy, position, count: 1 });
  } catch {
    // Match events never affect masking.
  }
}

/** Mask one text with compiled entries. */
export function maskSecretValuesInText(text: string, masks: CompiledSecretValueMasks): string {
  const sink = masks.onMatch;
  if (!sink) return maskOneText(text, masks, null);
  const tally: MatchTally = { events: new Map(), cursor: null };
  const out = maskOneText(text, masks, tally);
  for (const event of tally.events.values()) {
    try {
      sink(event);
    } catch {
      // Match events never affect masking.
    }
  }
  return out;
}

function maskOneText(
  text: string,
  masks: CompiledSecretValueMasks,
  tally: MatchTally | null,
): string {
  if (masks.empty || masks.pattern === null || text.length < masks.minChars) return text;
  if (masks.keepUrlHosts) {
    const address = ABSOLUTE_URL.exec(text);
    if (address) {
      const [, scheme, userInfo, host, rest] = address;
      const inner = { ...masks, keepUrlHosts: false };
      return (
        scheme! +
        (userInfo === undefined ? "" : `${maskSecretValuesInText(userInfo, inner)}@`) +
        host! +
        maskSecretValuesInText(rest!, inner)
      );
    }
  }
  for (const { pattern, label } of masks.formattedNumbers) {
    const kept = keptRanges(text, masks.pattern);
    text = text.replace(pattern, (match, at: number) =>
      overlapsKept(at, at + match.length, kept) ? match : label,
    );
  }
  const size = masks.minChars;
  // Existing labels and markers are skipped; where one starts, it wins, and
  // no match may run into one.
  const kept = keptRanges(text, masks.pattern);
  let out = "";
  let copied = 0;
  let next = 0;
  for (let at = 0; at <= text.length - size;) {
    while (next < kept.length && kept[next]![1] <= at) next += 1;
    if (next < kept.length && kept[next]![0] <= at) {
      at = kept[next]![1];
      next += 1;
      continue;
    }
    if (!masks.firstPairs.has(text.charCodeAt(at) * 65_536 + text.charCodeAt(at + 1))) {
      at += 1;
      continue;
    }
    const candidates = masks.byPrefix.get(text.slice(at, at + size));
    const limit = next < kept.length ? kept[next]![0] : text.length;
    let form: string | undefined;
    let keptForm: string | undefined;
    for (const candidate of candidates ?? []) {
      if (at + candidate.length > limit || !text.startsWith(candidate, at)) continue;
      const weak = masks.weakForms.get(candidate);
      if (weak && !weakValuePositionAllowed(text, at, at + candidate.length, weak)) {
        keptForm ??= candidate;
        continue;
      }
      form = candidate;
      break;
    }
    if (form === undefined) {
      // One event per position, however many forms of the value start here.
      if (keptForm !== undefined) reportMatch(masks, tally, keptForm, "kept", text, at);
      at += 1;
      continue;
    }
    reportMatch(masks, tally, form, "masked", text, at);
    out += text.slice(copied, at) + masks.labels.get(form)!;
    at += form.length;
    copied = at;
  }
  out += text.slice(copied);
  if (masks.byClippedEnd.size === 0) return out;
  // Truncation marks (not one right after another, as in `......`), and the
  // end of a long text. From the last cut back, so earlier positions stay valid.
  const cuts: number[] = out.length >= masks.clippedTextEndMinChars ? [out.length] : [];
  const marks = [...out.matchAll(TRUNCATION_MARK)];
  for (let index = marks.length - 1; index >= 0; index -= 1) {
    if (cuts.length >= CLIPPED_MAX_CUTS) break;
    const mark = marks[index]!;
    const previous = marks[index - 1];
    if (previous && previous.index + previous[0].length === mark.index) continue;
    cuts.push(mark.index);
  }
  if (cuts.length === 0) return out;
  const keptBefore = keptRanges(out, masks.pattern);
  let changedFrom = out.length + 1;
  for (const cut of cuts) {
    // A tail replaced at a later cut already covers this one.
    if (cut > changedFrom) continue;
    const tail = clippedSecretTail(out, cut, masks);
    if (!tail) continue;
    const start = cut - tail.length;
    if (overlapsKept(start, cut, keptBefore)) continue;
    reportMatch(masks, tally, tail.form, "masked", out, start);
    out = out.slice(0, start) + tail.label + out.slice(cut);
    changedFrom = start;
  }
  return out;
}

/**
 * Deep copy of `value` with every known secret value replaced in every string
 * (object keys are kept), except a tool's identity in conversation structure
 * unless `options.keepToolIdentities` is false (see
 * SecretMaskableStringsOptions.keepToolIdentities). Inputs that need no
 * change keep their identity.
 */
export function maskSecretValues<T>(
  value: T,
  entries: readonly SecretValueMaskEntry[] | CompiledSecretValueMasks,
  options: SecretValueMaskOptions = {},
): T {
  const masks = Array.isArray(entries)
    ? compileSecretValueMasks(entries as readonly SecretValueMaskEntry[], options)
    : (entries as CompiledSecretValueMasks);
  if (masks.empty) return value;
  return mapSecretMaskableStrings(
    value,
    (text) => maskSecretValuesInText(text, masks),
    masks.skipKey,
    { keepToolIdentities: options.keepToolIdentities !== false },
  );
}

// ---------------------------------------------------------------------------
// First-party call metadata
// ---------------------------------------------------------------------------

/**
 * The MCP `_meta` key on a worker's call to Opengeni's own server that
 * carries the values its arguments resolved to (with their references), so
 * the server masks them in what it stores and returns. Never logged.
 */
export const FIRST_PARTY_SECRET_VALUES_META_KEY = "opengeniSecretValues";

/** The resolved values a first-party call's `_meta` carries, if any. */
export function firstPartySecretValuesFromMeta(meta: unknown): SecretValueMaskEntry[] {
  if (meta === null || typeof meta !== "object") return [];
  const entries = (meta as Record<string, unknown>)[FIRST_PARTY_SECRET_VALUES_META_KEY];
  if (!Array.isArray(entries)) return [];
  return entries.filter(
    (entry): entry is SecretValueMaskEntry =>
      entry !== null &&
      typeof entry === "object" &&
      typeof (entry as SecretValueMaskEntry).value === "string" &&
      typeof (entry as SecretValueMaskEntry).label === "string",
  );
}

/**
 * Whether a secret-shaped value is distinctive enough to search for in any
 * text: at least 16 characters with three kinds of characters (lower case,
 * upper case, digits, others), or 24 with two, and not the user name beside it.
 */
function isDistinctiveSecret(value: string, username?: string): boolean {
  if (username !== undefined && value === username) return false;
  const kinds =
    Number(/[a-z]/.test(value)) +
    Number(/[A-Z]/.test(value)) +
    Number(/[0-9]/.test(value)) +
    Number(/[^A-Za-z0-9]/.test(value));
  return (value.length >= 16 && kinds >= 3) || (value.length >= 24 && kinds >= 2);
}

/** A revealed value as it appears in text: as written and JSON-escaped. */
function revealedForms(value: string): string[] {
  if (value.length === 0) return [];
  const escaped = JSON.stringify(value).slice(1, -1);
  return escaped === value ? [value] : [value, escaped];
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

/**
 * Saves detected secret-shaped values somewhere they can be used by
 * reference (the task vault) and returns, per value it saved, the reference
 * to write instead. Values it leaves out are masked with a fixed marker.
 */
export type SecretShapeCapturer = (
  matches: readonly SecretShapeMatch[],
) => Promise<ReadonlyMap<string, string>>;

/** Distinct new values captured from one tool result; the rest get a marker. */
export const SECRET_SHAPE_CAPTURES_PER_RESULT = 16;

/**
 * The secret values one owner (an agent attempt, a browser session) knows
 * about, with their labels, and masking against all of them. Masking never
 * throws: an internal failure returns the input unchanged and reports a
 * metadata-only diagnostic.
 */
export class SecretValueMemory {
  private readonly values = new Map<string, string>();
  private readonly operations = new Map<string, SecretValueMaskEntry[]>();
  private compiled: CompiledSecretValueMasks | null = null;
  /** Masks without values that only have a `[masked <kind>]` marker, by version. */
  private compiledReferenced: { version: number; masks: CompiledSecretValueMasks } | null = null;
  private changes = 0;
  private readonly options: SecretValueMaskOptions;
  private readonly maxEntries: number;
  private onDiagnostic: ((diagnostic: SecretValueMaskDiagnostic) => void) | undefined;
  private refresher: (() => Promise<void>) | undefined;
  /** Values an explicit, audited reveal (`secret_get`) handed to the agent. */
  private readonly revealed = new Set<string>();
  private disposed = false;
  /** Secret-shaped values seen in tool output, with what replaces them (any length). */
  private readonly shapes = new Map<string, string>();
  private shapeCapturer: SecretShapeCapturer | undefined;

  constructor(
    options: SecretValueMaskOptions & {
      maxEntries?: number;
      onDiagnostic?: (diagnostic: SecretValueMaskDiagnostic) => void;
    } = {},
  ) {
    const { maxEntries, onDiagnostic, ...maskOptions } = options;
    this.options = maskOptions;
    this.maxEntries = maxEntries ?? SECRET_VALUE_MEMORY_MAX_ENTRIES;
    this.onDiagnostic = onDiagnostic;
  }

  /** Replace the diagnostic sink (for example once observability is ready). */
  setDiagnosticSink(sink: ((diagnostic: SecretValueMaskDiagnostic) => void) | undefined): void {
    this.onDiagnostic = sink;
  }

  /**
   * Attach a loader that may remember more values (for example uses recorded
   * by another process). It owns its own throttling.
   */
  setRefresher(refresher: (() => Promise<void>) | undefined): void {
    this.refresher = refresher;
  }

  /** Run the refresher, waiting at most `maxWaitMs`; never throws. */
  async refresh(maxWaitMs = 2_000): Promise<void> {
    const refresher = this.refresher;
    if (!refresher) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        refresher(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, maxWaitMs);
        }),
      ]);
    } catch (error) {
      this.report("refresh", error);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  get minChars(): number {
    return this.options.minChars ?? SECRET_VALUE_MASK_MIN_CHARS;
  }

  get size(): number {
    return this.values.size;
  }

  /** Increases whenever the searched values change (for memoized masking). */
  get version(): number {
    return this.changes;
  }

  /**
   * Remember a value. Returns whether it is searched for (false when shorter
   * than the minimum). A value keeps its first reference label; a reference
   * label replaces a credential marker, because it is the more useful name.
   */
  remember(value: string, label: string): boolean {
    try {
      if (typeof value !== "string" || typeof label !== "string") return false;
      if (this.disposed || value.length < this.minChars || this.isRevealed(value)) return false;
      const existing = this.values.get(value);
      const keep =
        existing !== undefined &&
        (existing === label ||
          isSecretReferenceMaskLabel(existing) ||
          !isSecretReferenceMaskLabel(label));
      this.values.delete(value);
      this.values.set(value, keep ? existing! : label);
      this.evict();
      if (!keep) {
        this.compiled = null;
        this.changes += 1;
      }
      return true;
    } catch (error) {
      this.report("remember", error);
      return false;
    }
  }

  /**
   * Over the limit, the oldest values go first, but Opengeni's own
   * credentials (`[opengeni credential: …]`) stay while others can go.
   */
  private evict(): void {
    if (this.values.size <= this.maxEntries) return;
    for (const [value, label] of this.values) {
      if (this.values.size <= this.maxEntries) break;
      if (label.startsWith(CREDENTIAL_LABEL_OPEN)) continue;
      this.values.delete(value);
    }
    while (this.values.size > this.maxEntries) {
      const oldest = this.values.keys().next().value;
      if (oldest === undefined) break;
      this.values.delete(oldest);
    }
    this.compiled = null;
    this.changes += 1;
  }

  /**
   * An explicit, audited plaintext read (`secret_get`) handed this value to
   * the agent on purpose: it is not masked for the rest of this memory's
   * life. Never throws.
   */
  reveal(value: string): void {
    try {
      if (typeof value !== "string" || value.length === 0) return;
      this.revealed.add(value);
      // A value inside the revealed one (the password of a revealed URL) was
      // handed over with it, so it is released too; Opengeni's own
      // credentials stay masked.
      let changed = false;
      for (const [known, label] of this.values) {
        if (label.startsWith(CREDENTIAL_LABEL_OPEN) || !value.includes(known)) continue;
        this.values.delete(known);
        changed = true;
      }
      for (const known of this.shapes.keys()) {
        if (value.includes(known)) this.shapes.delete(known);
      }
      if (changed) {
        this.compiled = null;
        this.changes += 1;
      }
    } catch (error) {
      this.report("reveal", error);
    }
  }

  /**
   * Whether `value` is, or lies within, a value `secret_get` revealed. Only a
   * value of at least the minimum length counts as lying within one, so a
   * short value is not released by a chance match.
   */
  private isRevealed(value: string): boolean {
    if (this.revealed.size === 0) return false;
    if (this.revealed.has(value)) return true;
    if (value.length < this.minChars) return false;
    for (const revealed of this.revealed) if (revealed.includes(value)) return true;
    return false;
  }

  /**
   * Forget every value at the end of the owner's life (an attempt), so work
   * that outlives it neither keeps the plaintext nor masks with it.
   */
  dispose(): void {
    this.disposed = true;
    this.values.clear();
    this.operations.clear();
    this.revealed.clear();
    this.shapes.clear();
    this.shapeCapturer = undefined;
    this.refresher = undefined;
    this.compiled = null;
    this.compiledReferenced = null;
    this.changes += 1;
  }

  /**
   * Remember a value and note that one tool call (its operation ID) used it,
   * so the receiver of that call can mask its own stored text with exactly
   * the values it was given.
   */
  rememberForOperation(operationId: string, value: string, label: string): boolean {
    const searched = this.remember(value, label);
    if (!searched || !operationId) return searched;
    try {
      const entries = this.operations.get(operationId) ?? [];
      if (!entries.some((entry) => entry.value === value)) entries.push({ value, label });
      this.operations.delete(operationId);
      this.operations.set(operationId, entries);
      while (this.operations.size > 256) {
        const oldest = this.operations.keys().next().value;
        if (oldest === undefined) break;
        this.operations.delete(oldest);
      }
    } catch (error) {
      this.report("remember", error);
    }
    return searched;
  }

  /** The values one tool call used (see `rememberForOperation`). */
  operationEntries(operationId: string): SecretValueMaskEntry[] {
    return [...(this.operations.get(operationId) ?? [])];
  }

  /** Whether a value is remembered (for tests and dedupe; never exposes values). */
  has(value: string): boolean {
    return this.values.has(value);
  }

  entries(): SecretValueMaskEntry[] {
    return [...this.values].map(([value, label]) => ({ value, label }));
  }

  private masks(): CompiledSecretValueMasks {
    this.compiled ??= compileSecretValueMasks(this.entries(), this.options);
    return this.compiled;
  }

  /** Deep copy with every remembered value replaced; never throws. */
  mask<T>(value: T, stage = "mask"): T {
    if (this.values.size === 0) return value;
    try {
      return maskSecretValues(value, this.masks(), {
        keepToolIdentities: this.options.keepToolIdentities !== false,
      });
    } catch (error) {
      this.report(stage, error);
      return value;
    }
  }

  /**
   * `mask` for data, such as tool output, where a tool-shaped record is not
   * conversation structure: a tool's identity is masked too. Never throws.
   */
  maskData<T>(value: T, stage = "mask"): T {
    if (this.values.size === 0) return value;
    try {
      return maskSecretValues(value, this.masks(), { keepToolIdentities: false });
    } catch (error) {
      this.report(stage, error);
      return value;
    }
  }

  /** `mask` without the values whose label is only a `[masked <kind>]` marker. */
  private maskReferenced<T>(value: T, stage: string): T {
    if (this.values.size === 0) return value;
    let markers = false;
    for (const label of this.values.values()) {
      if (label.startsWith(SHAPE_MARKER_OPEN)) {
        markers = true;
        break;
      }
    }
    // Only tool output is searched for shapes: it is data.
    if (!markers) return this.maskData(value, stage);
    try {
      if (this.compiledReferenced?.version !== this.changes) {
        this.compiledReferenced = {
          version: this.changes,
          masks: compileSecretValueMasks(
            this.entries().filter((entry) => !entry.label.startsWith(SHAPE_MARKER_OPEN)),
            this.options,
          ),
        };
      }
      return maskSecretValues(value, this.compiledReferenced.masks, { keepToolIdentities: false });
    } catch (error) {
      this.report(stage, error);
      return value;
    }
  }

  /** Mask one text; never throws. */
  maskText(text: string, stage = "mask"): string {
    if (this.values.size === 0 || typeof text !== "string") return text;
    try {
      return maskSecretValuesInText(text, this.masks());
    } catch (error) {
      this.report(stage, error);
      return text;
    }
  }

  /** Mask with the remembered values plus, for this call only, extra ones. */
  maskWith<T>(value: T, extra: readonly SecretValueMaskEntry[], stage = "mask"): T {
    if (extra.length === 0) return this.mask(value, stage);
    try {
      return maskSecretValues(value, [...this.entries(), ...extra], this.options);
    } catch (error) {
      this.report(stage, error);
      return value;
    }
  }

  /**
   * Attach the capturer that saves secret-shaped values found in tool output
   * (normally into the task vault). Without one they are masked with a marker.
   */
  setShapeCapturer(capturer: SecretShapeCapturer | undefined): void {
    this.shapeCapturer = capturer;
  }

  /**
   * Remember a secret-shaped value from tool output: it is replaced wherever
   * a shape detector finds it, and (when long enough) searched for as a known
   * value everywhere else. A reference replaces an earlier marker.
   */
  rememberShape(value: string, label: string, username?: string): void {
    try {
      if (typeof value !== "string" || typeof label !== "string" || value.length === 0) return;
      // An ended attempt keeps nothing; a value `secret_get` revealed stays readable.
      if (this.disposed || this.isRevealed(value)) return;
      const existing = this.shapes.get(value);
      if (
        existing === undefined ||
        (!isSecretReferenceMaskLabel(existing) && isSecretReferenceMaskLabel(label))
      ) {
        this.shapes.set(value, label);
        while (this.shapes.size > this.maxEntries) {
          const oldest = this.shapes.keys().next().value;
          if (oldest === undefined) break;
          this.shapes.delete(oldest);
        }
      }
      // Searched everywhere else only when it is distinctive: a weak or
      // common password (`postgres`, the URL's own user name) would mask
      // ordinary words. Where a detector finds it, it is masked regardless.
      if (isDistinctiveSecret(value, username)) {
        this.remember(value, this.shapes.get(value) ?? label);
      }
    } catch (error) {
      this.report("remember_shape", error);
    }
  }

  /**
   * Find secret-shaped values in tool output that are not known yet and
   * capture them, waiting at most `maxWaitMs`. Values the capturer does not
   * return a reference for (or all of them, without a capturer or on any
   * failure) are remembered with a `[masked <kind>]` marker. Never throws.
   */
  async captureShapes(value: unknown, stage = "tool_result", maxWaitMs = 5_000): Promise<void> {
    let pending: SecretShapeMatch[];
    try {
      // Known values are masked first (a detected part of a vault secret is
      // not captured again), except values that only have a marker: those
      // are detected again, so a failed or skipped capture is retried.
      const known = this.maskReferenced(value, stage);
      // Values that already have a reference are done; markers are retried.
      pending = collectSecretShapes(known, 256, {
        ...(this.options.skipKey ? { skipKey: this.options.skipKey } : {}),
        keep: (match, text) => !this.insideRevealed(match, text) && !this.isRevealed(match.value),
      }).filter((match) => !isSecretReferenceMaskLabel(this.shapes.get(match.value) ?? ""));
    } catch (error) {
      this.report(stage, error);
      return;
    }
    if (pending.length === 0) return;
    const capturable = pending.slice(0, SECRET_SHAPE_CAPTURES_PER_RESULT);
    const usernames = new Map(pending.map((match) => [match.value, match.username]));
    let captured: ReadonlyMap<string, string> = new Map();
    const capturer = this.shapeCapturer;
    if (capturer) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const late = capturer(capturable);
        // A capture that finishes after the wait still upgrades the markers.
        late.then(
          (references) => {
            for (const [secret, reference] of references) {
              if (!isSecretReferenceMaskLabel(reference)) continue;
              this.rememberShape(secret, reference, usernames.get(secret));
            }
          },
          () => {},
        );
        captured =
          (await Promise.race([
            late,
            new Promise<null>((resolve) => {
              timer = setTimeout(() => resolve(null), maxWaitMs);
            }),
          ])) ?? new Map();
      } catch (error) {
        this.report("shape_capture", error);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
    for (const match of pending) {
      const reference = captured.get(match.value);
      this.rememberShape(
        match.value,
        reference && isSecretReferenceMaskLabel(reference)
          ? reference
          : secretShapeMaskLabel(match.kind),
        match.username,
      );
    }
  }

  /**
   * Whether a detected part lies within a value `secret_get` revealed (as
   * written or JSON-escaped), for example the password of a revealed URL.
   */
  private insideRevealed(match: SecretShapeMatch, text: string): boolean {
    if (this.revealed.size === 0) return false;
    for (const value of this.revealed) {
      for (const form of revealedForms(value)) {
        const at = text.indexOf(form, Math.max(0, match.start - form.length + 1));
        if (at >= 0 && at < match.end) return true;
      }
    }
    return false;
  }

  /** What replaces a detected shape: its capture, a known label, a marker, or nothing when revealed. */
  private shapeLabel = (match: SecretShapeMatch, text: string): string | null =>
    this.insideRevealed(match, text) || this.isRevealed(match.value)
      ? null
      : (this.shapes.get(match.value) ??
        this.values.get(match.value) ??
        secretShapeMaskLabel(match.kind));

  /**
   * Mask tool output: known values first, then every secret-shaped part
   * (with its captured reference, or a marker). Never throws.
   */
  maskToolOutput<T>(value: T, stage = "tool_result"): T {
    const known = this.maskData(value, stage);
    try {
      return maskSecretShapes(known, this.shapeLabel, this.options.skipKey);
    } catch (error) {
      this.report(stage, error);
      return known;
    }
  }

  /** `maskToolOutput` for one text. */
  maskToolOutputText(text: string, stage = "tool_result"): string {
    const known = this.maskText(text, stage);
    if (typeof known !== "string") return known;
    try {
      return maskSecretShapesInText(known, this.shapeLabel);
    } catch (error) {
      this.report(stage, error);
      return known;
    }
  }

  private report(stage: string, error: unknown): void {
    try {
      this.onDiagnostic?.({ stage, error: error instanceof Error ? error.name : typeof error });
    } catch {
      // Diagnostics never affect masking.
    }
  }
}

/**
 * Mask an error's message, stack, causes and inner errors (`AggregateError`)
 * in place with `memory` (bounded depth) and return it, so a rethrown error
 * carries references, not values. In "tool_output" mode secret-shaped parts
 * are masked too.
 * Never throws: on failure the original error is returned as it is.
 */
export function maskSecretValuesInError<E>(
  error: E,
  memory: SecretValueMemory | null | undefined,
  mode: "known" | "tool_output" = "known",
  depth = 0,
): E {
  // Tool output also masks secret-shaped parts (with or without known values).
  if (!memory || !(error instanceof Error) || depth > 4) return error;
  if (mode === "known" && memory.size === 0) return error;
  // Each part on its own, so one read-only field does not stop the rest.
  const field = (name: "message" | "stack") => {
    try {
      const text = error[name];
      if (typeof text !== "string") return;
      const masked =
        mode === "tool_output"
          ? memory.maskToolOutputText(text, "tool_error")
          : memory.maskText(text, "tool_error");
      if (masked !== text) error[name] = masked;
    } catch {
      // The original text stays.
    }
  };
  field("message");
  field("stack");
  try {
    if (error.cause !== undefined) maskSecretValuesInError(error.cause, memory, mode, depth + 1);
  } catch {
    // The cause stays as it is.
  }
  try {
    const inner = (error as { errors?: unknown }).errors;
    if (Array.isArray(inner)) {
      for (const item of inner.slice(0, 32)) {
        maskSecretValuesInError(item, memory, mode, depth + 1);
      }
    }
  } catch {
    // The inner errors stay as they are.
  }
  return error;
}

// ---------------------------------------------------------------------------
// Explicit reveals
// ---------------------------------------------------------------------------

/**
 * Opengeni's audited plaintext read, which hands a value to the agent on
 * purpose: exactly its own `secret_get` (as the agent sees it, bare or with
 * the first-party prefix). A connector's tool of the same name is not one.
 */
export function isSecretRevealToolName(name: string): boolean {
  return name === "secret_get" || name === "opengeni__secret_get";
}

function decodedBase64Text(value: string): string | null {
  try {
    const binary = atob(value.replace(/\s+/gu, ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * The values a `secret_get` result reveals (`{ value, encoding }`, possibly
 * as JSON text). A base64 result reveals both the encoded text and the
 * decoded UTF-8 text, since the memory holds the decoded value.
 */
export function secretGetRevealedValues(result: unknown, depth = 0): string[] {
  if (depth > 6) return [];
  if (typeof result === "string") {
    const trimmed = result.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return [];
    try {
      return secretGetRevealedValues(JSON.parse(trimmed), depth + 1);
    } catch {
      return [];
    }
  }
  if (result === null || typeof result !== "object") return [];
  if (Array.isArray(result)) {
    return result.flatMap((item) => secretGetRevealedValues(item, depth + 1));
  }
  const record = result as Record<string, unknown>;
  if (typeof record.value === "string" && record.encoding === "utf8") return [record.value];
  if (typeof record.value === "string" && record.encoding === "base64") {
    const decoded = decodedBase64Text(record.value);
    return decoded === null ? [record.value] : [record.value, decoded];
  }
  return Object.values(record).flatMap((value) => secretGetRevealedValues(value, depth + 1));
}

/**
 * When `toolName` is `secret_get`, mark what its result reveals as readable
 * for the rest of the memory's life, so masking the result leaves it intact.
 * Never throws.
 */
export function revealSecretGetResult(
  memory: SecretValueMemory | null | undefined,
  toolName: string,
  result: unknown,
): void {
  if (!memory) return;
  try {
    if (!isSecretRevealToolName(toolName)) return;
    for (const value of secretGetRevealedValues(result)) memory.reveal(value);
  } catch {
    // Masking applies as usual.
  }
}

// ---------------------------------------------------------------------------
// Resolver integration
// ---------------------------------------------------------------------------

function textMaterial(value: ResolvedSecretValue): string | null {
  const material = value.material;
  if (material.type === "text") return material.value;
  if (material.type === "bytes") {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(material.value);
    } catch {
      return null;
    }
  }
  // A one-time code is six or eight digits that change every period: below
  // the useful minimum and not worth searching for.
  return null;
}

/** Remember what one resolver call returned, labelled by reference; never throws. */
export function rememberResolvedSecretValues(
  memory: SecretValueMemory | null | undefined,
  resolved: ReadonlyMap<string, ResolvedSecretValue>,
  operationId?: string,
): void {
  if (!memory) return;
  for (const value of resolved.values()) {
    try {
      // A plain text field (a username, a host name) is not secret: masking it
      // would rewrite every page, log line and URL that mentions it.
      if (value.fieldKind === "text") continue;
      const text = textMaterial(value);
      if (text === null) continue;
      const label = secretReferenceMaskLabel({
        raw: value.reference.raw,
        itemId: value.itemId,
        fieldName: value.fieldName,
      });
      if (operationId) memory.rememberForOperation(operationId, text, label);
      else memory.remember(text, label);
    } catch {
      // Remembering never fails a resolution.
    }
  }
}

/** The same resolver, remembering every value it returns in the memory `target` names at resolution time. */
export function rememberingSecretResolver(
  resolver: SecretResolver,
  target: SecretValueMemory | (() => SecretValueMemory | null | undefined),
): SecretResolver {
  return {
    get principal() {
      return resolver.principal;
    },
    get enabled() {
      return resolver.enabled;
    },
    async resolve(refs, use) {
      const resolved = await resolver.resolve(refs, use);
      let memory: SecretValueMemory | null | undefined;
      try {
        memory = typeof target === "function" ? target() : target;
      } catch {
        memory = null;
      }
      rememberResolvedSecretValues(memory, resolved, use.operationId);
      return resolved;
    },
  };
}
