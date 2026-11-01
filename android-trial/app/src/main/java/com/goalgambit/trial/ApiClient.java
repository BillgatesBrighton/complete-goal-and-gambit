package com.goalgambit.trial;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

final class ApiClient {
    static final class Result {
        final int status;
        final JSONObject object;
        final JSONArray array;
        final boolean arrayResponse;

        Result(int status, JSONObject object, JSONArray array, boolean arrayResponse) {
            this.status = status;
            this.object = object == null ? new JSONObject() : object;
            this.array = array == null ? new JSONArray() : array;
            this.arrayResponse = arrayResponse;
        }

        boolean ok() {
            return status >= 200 && status < 300 &&
                (arrayResponse || object.optBoolean("success", false));
        }

        String message(String fallback) {
            return object.optString("message", fallback);
        }
    }

    private ApiClient() {}

    static Result request(String method, String path, String bearer, JSONObject body) throws Exception {
        String base = BuildConfig.API_BASE_URL.replaceAll("/+$", "");
        if (!base.startsWith("https://")) {
            throw new IllegalStateException("The trial app requires a secure HTTPS connection.");
        }
        if (path == null || !path.startsWith("/api/") || path.contains("..")) {
            throw new IllegalArgumentException("Invalid API path.");
        }

        HttpURLConnection connection = (HttpURLConnection) new URL(base + path).openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(10000);
        connection.setReadTimeout(15000);
        connection.setUseCaches(false);
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("Cache-Control", "no-store");
        try {
            if (bearer != null && !bearer.isEmpty()) {
                connection.setRequestProperty("Authorization", "Bearer " + bearer);
            }
            if (body != null) {
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                try (java.io.OutputStream output = connection.getOutputStream()) {
                    output.write(body.toString().getBytes(StandardCharsets.UTF_8));
                }
            }

            int status = connection.getResponseCode();
            InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            String text = "";
            if (stream != null) {
                try (InputStream input = stream; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                    byte[] buffer = new byte[4096];
                    int read;
                    while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
                    text = new String(output.toByteArray(), StandardCharsets.UTF_8).trim();
                }
            }

            JSONObject object = new JSONObject();
            JSONArray array = new JSONArray();
            boolean arrayResponse = text.startsWith("[");
            if (arrayResponse) array = new JSONArray(text);
            else if (text.startsWith("{")) object = new JSONObject(text);
            else if (status >= 500) object.put("message", "The server could not complete that request.");
            return new Result(status, object, array, arrayResponse);
        } finally {
            connection.disconnect();
        }
    }
}
