import { type OpenGeniText } from "../messages/runtime";
/** Decorative loading copy shared by every renderer of the preparing state. */
export const GENIE_PREPARING_PHRASES = (t: OpenGeniText): readonly string[] => [
  t("timeline.genieCopy.polishingTheLamp"),
  t("timeline.genieCopy.consultingTheCarpet"),
  t("timeline.genieCopy.untanglingWishes"),
  t("timeline.genieCopy.summoningALittleCleverness"),
  t("timeline.genieCopy.checkingTheFinePrintOn"),
  t("timeline.genieCopy.warmingUpTheAbracadabra"),
  t("timeline.genieCopy.rearrangingTheStars"),
  t("timeline.genieCopy.negotiatingWithTheLamp"),
  t("timeline.genieCopy.dustingOffAThousandYears"),
  t("timeline.genieCopy.wishfulThinking"),
  t("timeline.genieCopy.decantingALittleMagic"),
  t("timeline.genieCopy.findingTheGoodStardust"),
  t("timeline.genieCopy.fluffingTheMagicCarpet"),
  t("timeline.genieCopy.puttingAWishIntoMotion"),
  t("timeline.genieCopy.aLittleHocusALittle"),
];
export const GENIE_WAITING_PHRASES = (t: OpenGeniText): readonly string[] => [
  t("timeline.genieCopy.waitingForAResponse"),
];
