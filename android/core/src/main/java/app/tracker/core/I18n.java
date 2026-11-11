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
            {"Blockwise", "Blockwise"},
            {"Something went wrong.", "Qualcosa è andato storto."},
            {"Blockwise may not write to your calendar.", "Blockwise non può scrivere nel tuo calendario."},
            {"This commitment's calendar is not on this phone. Turn it on in DAVx5.", "Il calendario di questo impegno non è su questo telefono. Attivalo in DAVx5."},
            {"This calendar is read-only.", "Questo calendario è di sola lettura."},
            {"Could not add the block.", "Impossibile aggiungere il blocco."},
            {"Some changes on this phone are not synced yet and will be lost.", "Alcune modifiche su questo telefono non sono ancora sincronizzate e andranno perse."},
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
            {"On this phone only", "Solo su questo telefono"},
            {"Sync with Nextcloud", "Sincronizza con Nextcloud"},
            {"Log out of {host}?", "Uscire da {host}?"},
            {"The app password is removed from Nextcloud.", "La password dell'app viene rimossa da Nextcloud."},
            {"\"Keep on this phone\": Blockwise goes on without an account, with your commitments, tasks, notes and tracked time. Blocks stay in your Nextcloud calendars.", "\"Tieni su questo telefono\": Blockwise continua senza account, con impegni, task, note e tempo registrato. I blocchi restano nei calendari di Nextcloud."},
            {"Some changes on this phone are not synced yet: \"Keep on this phone\" keeps them, \"Remove\" loses them.", "Alcune modifiche su questo telefono non sono ancora sincronizzate: \"Tieni su questo telefono\" le conserva, \"Rimuovi\" le perde."},
            {"Keep on this phone", "Tieni su questo telefono"},
            {"Remove", "Rimuovi"},
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
            {"The Blockwise app is not enabled on this Nextcloud.", "L'app Blockwise non è attiva su questo Nextcloud."},
            {"Request failed (HTTP {status}).", "Richiesta non riuscita (HTTP {status})."},
            {"Invalid request.", "Richiesta non valida."},
            {"Not logged in.", "Non hai effettuato l'accesso."},
            {"Nextcloud redirected the request. Use the address Nextcloud is reachable at.", "Nextcloud ha reindirizzato la richiesta. Usa l'indirizzo con cui Nextcloud è raggiungibile."},
            {"Blockwise could not use the Android Keystore", "Blockwise non è riuscito a usare il Keystore di Android"},
            {"You stay logged in until you close Blockwise; the password is not saved.", "Resti connesso finché non chiudi Blockwise; la password non viene salvata."},
            {"Allow exact reminders", "Consenti promemoria precisi"},
            {"So reminders arrive on the minute, allow Blockwise to set exact alarms.", "Perché i promemoria arrivino al minuto, consenti a Blockwise di impostare sveglie precise."},
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
