package com.jyotishtrader.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.view.View;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashMap;
import java.util.Map;

public class MainActivity extends Activity {
  private static final int EXPORT_REQUEST = 4102;
  private WebView web;
  private byte[] pendingExport;

  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    getWindow().setStatusBarColor(0xff080d20);
    getWindow().setNavigationBarColor(0xff080d20);
    getWindow().getDecorView().setSystemUiVisibility(0);
    web = new WebView(this);
    web.setBackgroundColor(0xff080d20);
    WebSettings settings = web.getSettings();
    settings.setJavaScriptEnabled(true);
    settings.setDomStorageEnabled(true);
    settings.setAllowFileAccess(true);
    settings.setAllowContentAccess(false);
    settings.setAllowFileAccessFromFileURLs(false);
    settings.setAllowUniversalAccessFromFileURLs(false);
    settings.setCacheMode(WebSettings.LOAD_DEFAULT);
    web.setWebViewClient(new WebViewClient() {
      @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        Uri uri = request.getUrl();
        String url = uri.toString();
        String path = uri.getPath();
        if ("https".equals(uri.getScheme()) && "api.binance.com".equals(uri.getHost()) &&
            ("/api/v3/ticker/24hr".equals(path) || "/api/v3/klines".equals(path))) {
          return fetchPublicMarketData(url);
        }
        return super.shouldInterceptRequest(view, request);
      }
    });
    web.addJavascriptInterface(new ExportBridge(), "AndroidExport");
    setContentView(web);
    web.loadUrl("file:///android_asset/index.html");
  }

  private final class ExportBridge {
    @JavascriptInterface public void saveCsv(String filename, String contents) {
      if (contents == null || contents.length() > 1_000_000) return;
      String safeName = filename == null ? "jyotish-trader-history.csv" : filename.replaceAll("[^A-Za-z0-9._-]", "_");
      pendingExport = contents.getBytes(java.nio.charset.StandardCharsets.UTF_8);
      runOnUiThread(() -> {
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("text/csv");
        intent.putExtra(Intent.EXTRA_TITLE, safeName);
        startActivityForResult(intent, EXPORT_REQUEST);
      });
    }
  }

  @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
    super.onActivityResult(requestCode, resultCode, data);
    if (requestCode != EXPORT_REQUEST) return;
    if (resultCode == RESULT_OK && data != null && data.getData() != null && pendingExport != null) {
      try (OutputStream output = getContentResolver().openOutputStream(data.getData())) {
        if (output == null) throw new java.io.IOException("Could not open destination");
        output.write(pendingExport);
        android.widget.Toast.makeText(this, "History CSV saved", android.widget.Toast.LENGTH_LONG).show();
      } catch (Exception error) {
        android.widget.Toast.makeText(this, "Could not save history CSV", android.widget.Toast.LENGTH_LONG).show();
      }
    }
    pendingExport = null;
  }

  private WebResourceResponse fetchPublicMarketData(String url) {
    HttpURLConnection connection = null;
    try {
      connection = (HttpURLConnection) new URL(url).openConnection();
      connection.setRequestMethod("GET");
      connection.setConnectTimeout(8000);
      connection.setReadTimeout(8000);
      connection.setRequestProperty("Accept", "application/json");
      int code = connection.getResponseCode();
      InputStream stream = code >= 200 && code < 300 ? connection.getInputStream() : connection.getErrorStream();
      java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream();
      if (stream != null) {
        byte[] buffer = new byte[8192];
        int count;
        while ((count = stream.read(buffer)) != -1) output.write(buffer, 0, count);
        stream.close();
      } else {
        output.write("[]".getBytes("UTF-8"));
      }
      Map<String, String> headers = new HashMap<>();
      headers.put("Access-Control-Allow-Origin", "*");
      headers.put("Access-Control-Allow-Methods", "GET, OPTIONS");
      headers.put("Access-Control-Allow-Headers", "*");
      headers.put("Cache-Control", "no-store");
      headers.put("Vary", "Origin");
      String reason = code == 200 ? "OK" : "Market feed unavailable";
      return new WebResourceResponse("application/json", "UTF-8", code, reason, headers,
          new ByteArrayInputStream(output.toByteArray()));
    } catch (Exception error) {
      Map<String, String> headers = new HashMap<>();
      headers.put("Access-Control-Allow-Origin", "*");
      headers.put("Cache-Control", "no-store");
      return new WebResourceResponse("application/json", "UTF-8", 503, "Market feed unavailable", headers,
          new ByteArrayInputStream("[]".getBytes()));
    } finally {
      if (connection != null) connection.disconnect();
    }
  }
  @Override public void onBackPressed() {
    if (web != null && web.canGoBack()) web.goBack(); else super.onBackPressed();
  }

  @Override protected void onDestroy() {
    if (web != null) { web.stopLoading(); web.destroy(); web = null; }
    super.onDestroy();
  }
}

