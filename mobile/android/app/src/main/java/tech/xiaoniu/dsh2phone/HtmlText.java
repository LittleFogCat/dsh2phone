package tech.xiaoniu.dsh2phone;

import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** relay 返回的是纯 HTML 页面，这里只做非常小的提取：标题、提示、设备名、入口链接。 */
public final class HtmlText {
    private static final Pattern TITLE = Pattern.compile("<title[^>]*>(.*?)</title>", Pattern.CASE_INSENSITIVE | Pattern.DOTALL);
    private static final Pattern H1 = Pattern.compile("<h1[^>]*>(.*?)</h1>", Pattern.CASE_INSENSITIVE | Pattern.DOTALL);
    private static final Pattern P = Pattern.compile("<p[^>]*>(.*?)</p>", Pattern.CASE_INSENSITIVE | Pattern.DOTALL);
    private static final Pattern SCRIPT = Pattern.compile("<script\\b[^>]*>.*?</script>", Pattern.CASE_INSENSITIVE | Pattern.DOTALL);
    private static final Pattern STYLE = Pattern.compile("<style\\b[^>]*>.*?</style>", Pattern.CASE_INSENSITIVE | Pattern.DOTALL);
    private static final Pattern TAG = Pattern.compile("<[^>]+>");
    private static final Pattern ANCHOR = Pattern.compile("<a\\b[^>]*>", Pattern.CASE_INSENSITIVE | Pattern.DOTALL);
    private static final Pattern CLASS_ATTR = Pattern.compile("class\\s*=\\s*\"([^\"]*)\"", Pattern.CASE_INSENSITIVE);
    private static final Pattern HREF_ATTR = Pattern.compile("href\\s*=\\s*\"([^\"]*)\"", Pattern.CASE_INSENSITIVE);
    private static final Pattern SPAN_DEVICE = Pattern.compile(
            "<span[^>]*class\\s*=\\s*\"[^\"]*device[^\"]*\"[^>]*>(.*?)</span>",
            Pattern.CASE_INSENSITIVE | Pattern.DOTALL);

    private HtmlText() {
    }

    public static String title(String html) {
        return clean(firstGroup(TITLE, html));
    }

    public static String h1(String html) {
        return clean(firstGroup(H1, html));
    }

    public static String firstParagraph(String html) {
        return clean(firstGroup(P, html));
    }

    public static String textByClass(String html, String className) {
        if (html == null || className == null) return "";
        if ("device".equals(className)) {
            return clean(firstGroup(SPAN_DEVICE, html));
        }
        return "";
    }

    /** 返回 class 含 enter 的 <a> 的 href；没有则 null。 */
    public static String hrefByClass(String html, String className) {
        if (html == null || className == null) return null;
        Matcher m = ANCHOR.matcher(html);
        while (m.find()) {
            String tag = m.group();
            Matcher cm = CLASS_ATTR.matcher(tag);
            if (!cm.find()) continue;
            String classes = cm.group(1).toLowerCase(Locale.ROOT);
            if (!classes.contains(className.toLowerCase(Locale.ROOT))) continue;
            Matcher hm = HREF_ATTR.matcher(tag);
            if (hm.find()) return unescape(hm.group(1)).trim();
        }
        return null;
    }

    public static String stripTags(String html) {
        if (html == null) return "";
        String s = SCRIPT.matcher(html).replaceAll(" ");
        s = STYLE.matcher(s).replaceAll(" ");
        s = TAG.matcher(s).replaceAll(" ");
        return unescape(s).replaceAll("\\s+", " ").trim();
    }

    static String clean(String value) {
        if (value == null) return "";
        return stripTags(value);
    }

    private static String firstGroup(Pattern pattern, String html) {
        if (html == null) return null;
        Matcher m = pattern.matcher(html);
        return m.find() ? m.group(1) : null;
    }

    static String unescape(String value) {
        if (value == null) return "";
        return value
                .replace("&nbsp;", " ")
                .replace("&amp;", "&")
                .replace("&lt;", "<")
                .replace("&gt;", ">")
                .replace("&quot;", "\"")
                .replace("&#39;", "'")
                .replace("&#x27;", "'")
                .replace("&#x2F;", "/");
    }
}
