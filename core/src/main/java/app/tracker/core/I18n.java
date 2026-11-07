package app.tracker.core;

import java.util.Collections;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Texts of the notifications and native dialogs (English, Italian). Same keys as the Mac app. */
public final class I18n {
    private static final Map<String, String> IT = new HashMap<>();

    static {
        String[][] it = {
            {"Tracker", "Tracker"},
            {"Unplanned", "Non pianificato"},
            {"Tracking", "Registrazione in corso"},
            {"Stop", "Ferma"},
            {"Focus", "Concentrazione"},
            {"Short break", "Pausa breve"},
            {"Long break", "Pausa lunga"},
            {"Round {round} of {of}", "Sessione {round} di {of}"},
            {"{time} left in this block", "{time} rimanenti in questo blocco"},
            {"Back to work in {time}", "Si riprende tra {time}"},
            {"{name}: block ends soon", "{name}: il blocco sta per finire"},
            {"{minutes} min left. Unchecked subtasks move to the next block.", "Mancano {minutes} min. I sottotask non spuntati passano al prossimo blocco."},
            {"Step away for {minutes} min. The timer keeps running.", "Staccati per {minutes} min. Il timer continua."},
            {"Back to focus", "Torna a concentrarti"},
            {"Time for a long break", "È ora di una pausa lunga"},
            {"Tracking stopped. Back to work in {minutes} min.", "Registrazione fermata. Si riprende tra {minutes} min."},
            {"Break is over", "La pausa è finita"},
            {"Press play to start the next focus session.", "Premi play per iniziare la prossima sessione di concentrazione."},
            {"Timer", "Timer"},
            {"Shows the running timer while you track time.", "Mostra il timer mentre registri il tempo."},
            {"Reminders", "Promemoria"},
            {"Block ending, Pomodoro breaks.", "Fine del blocco, pause Pomodoro."},
            {"Account", "Account"},
            {"Logged in as {user} on {host}", "Accesso come {user} su {host}"},
            {"Notifications", "Notifiche"},
            {"Log out", "Esci"},
            {"Cancel", "Annulla"},
            {"Close", "Chiudi"},
            {"Log out of {host}? The app password is removed from Nextcloud.", "Uscire da {host}? La password dell'app viene rimossa da Nextcloud."},
            {"Log in again", "Accedi di nuovo"},
            {"Nextcloud rejected the app password. Log in again.", "Nextcloud ha rifiutato la password dell'app. Accedi di nuovo."},
            {"Enter the address of your Nextcloud.", "Inserisci l'indirizzo del tuo Nextcloud."},
            {"That is not a valid address.", "Non è un indirizzo valido."},
            {"Use an https:// address.", "Usa un indirizzo https://."},
            {"Use an https:// address: over plain http your password could be read on the network.", "Usa un indirizzo https://: con http semplice la password potrebbe essere letta sulla rete."},
            {"This doesn't look like a Nextcloud server.", "Non sembra un server Nextcloud."},
            {"Can't reach {host}. Check the address and your connection (and Tailscale).", "Impossibile raggiungere {host}. Controlla l'indirizzo e la connessione (e Tailscale)."},
            {"Login cancelled.", "Accesso annullato."},
            {"Login timed out.", "Accesso scaduto."},
            {"Nextcloud is in maintenance mode or updating.", "Nextcloud è in manutenzione o si sta aggiornando."},
            {"The Tracker app is not enabled on this Nextcloud.", "L'app Tracker non è attiva su questo Nextcloud."},
            {"Request failed (HTTP {status}).", "Richiesta non riuscita (HTTP {status})."},
            {"Invalid request.", "Richiesta non valida."},
            {"Not logged in.", "Non hai effettuato l'accesso."},
            {"Nextcloud redirected the request. Use the address Nextcloud is reachable at.", "Nextcloud ha reindirizzato la richiesta. Usa l'indirizzo con cui Nextcloud è raggiungibile."},
            {"Tracker could not use the Android Keystore", "Tracker non è riuscito a usare il Keystore di Android"},
            {"You stay logged in until you close Tracker; the password is not saved.", "Resti connesso finché non chiudi Tracker; la password non viene salvata."},
            {"Allow exact reminders", "Consenti promemoria precisi"},
            {"So reminders arrive on the minute, allow Tracker to set exact alarms.", "Perché i promemoria arrivino al minuto, consenti a Tracker di impostare sveglie precise."},
            {"Open settings", "Apri impostazioni"},
            {"Not now", "Non ora"},
            {"No calendar app found.", "Nessuna app calendario trovata."},
        };
        for (String[] p : it) {
            IT.put(p[0], p[1]);
        }
    }

    private static final Pattern VAR = Pattern.compile("\\{(\\w+)\\}");
    private final Map<String, String> dict;

    private I18n(Map<String, String> dict) {
        this.dict = dict;
    }

    public static I18n forLocale(Locale locale) {
        return new I18n(locale != null && "it".equals(locale.getLanguage()) ? IT : Collections.emptyMap());
    }

    public String t(String s) {
        return t(s, Collections.emptyMap());
    }

    public String t(String s, Map<String, String> vars) {
        String text = dict.getOrDefault(s, s);
        Matcher m = VAR.matcher(text);
        StringBuffer sb = new StringBuffer(); // StringBuilder overload needs Android 14
        while (m.find()) {
            String v = vars.get(m.group(1));
            m.appendReplacement(sb, Matcher.quoteReplacement(v != null ? v : m.group(0)));
        }
        m.appendTail(sb);
        return sb.toString();
    }
}
