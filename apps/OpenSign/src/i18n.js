import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import Backend from "i18next-http-backend";
import LanguageDetector from "i18next-browser-languagedetector";

i18n
  .use(Backend)
  .use(LanguageDetector) // Use LanguageDetector directly without creating an instance
  .use(initReactI18next)
  .init({
    backend: {
      loadPath: "/locales/{{lng}}/{{ns}}.json"
    },
    fallbackLng: "en", // Fallback to English if no other language is detected
    detection: {
      // Specifies the default language to fall back to if the detected language is not available.
      order: ["localStorage", "navigator"],
      // Defines where the detected language should be cached.
      caches: ["localStorage"],
      // Browsers report Korean as "ko"; our Korean locale folder is "kr".
      convertDetectedLanguage: (lng) => (/^ko\b/i.test(lng) ? "kr" : lng)
    },
    ns: ["translation"], // default namespace
    defaultNS: "translation", // default namespace
    //Enables debug mode, which outputs detailed logs to the console about the translation process.
    debug: false,
    interpolation: {
      escapeValue: false // Not needed for react as it escapes by default
    },
    // List of allowed languages; a regional code such as "en-US" resolves to
    // "en", so the language dropdown always has a matching option.
    supportedLngs: ["en", "es", "fr", "it", "de", "hi", "kr"]
  });

// Keep <html lang> in step so screen readers and fonts follow the language.
i18n.on("languageChanged", (lng) => {
  document.documentElement.lang = lng === "kr" ? "ko" : lng;
});

export default i18n;
