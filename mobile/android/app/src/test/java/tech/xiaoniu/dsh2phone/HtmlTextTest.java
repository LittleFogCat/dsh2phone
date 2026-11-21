package tech.xiaoniu.dsh2phone;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

public final class HtmlTextTest {
    @Test
    public void extractsLandingPageFields() {
        String html = "<!doctype html><html><head><title>已连接 DSH</title></head><body>"
                + "<h1>配对成功</h1><p><span class=\"device\">Pixel 9</span> 已加入设备白名单。</p>"
                + "<a class=\"enter\" href=\"/dsh/\">进入 DSH</a></body></html>";
        assertEquals("已连接 DSH", HtmlText.title(html));
        assertEquals("配对成功", HtmlText.h1(html));
        assertEquals("Pixel 9", HtmlText.textByClass(html, "device"));
        assertEquals("/dsh/", HtmlText.hrefByClass(html, "enter"));
    }

    @Test
    public void hrefMayComeBeforeClass() {
        String html = "<a href=\"/dsh/\" class=\"enter big\">go</a>";
        assertEquals("/dsh/", HtmlText.hrefByClass(html, "enter"));
    }

    @Test
    public void stripsTagsAndUnescapes() {
        assertEquals("配对失败 配对码&无效", HtmlText.stripTags("<p>配对失败</p><p>配对码&amp;无效</p>"));
    }

    @Test
    public void missingFieldsAreNull() {
        assertNull(HtmlText.hrefByClass("<html></html>", "enter"));
        assertEquals("", HtmlText.title("<html></html>"));
    }
}
