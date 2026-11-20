' Requests to the hub, off the render thread, with the Cloudflare Access service
' token when there is one. config.mode:
'   "stream"   GET <url>/api/stream?view=<view>&output=roku
'                → result { stream } or { error, offline }
'                  offline = true when the hub couldn't be reached (keep the last stream)
'   "download" GET config.imageUrl (a card's glance.image) to config.path
'                → result { id, path, url } or { id, error }

sub init()
    m.top.functionName = "doRequest"
end sub

sub doRequest()
    cfg = m.top.config
    xfer = makeTransfer(cfg)
    port = CreateObject("roMessagePort")
    xfer.SetMessagePort(port)

    download = cfg.mode = "download"
    if download then
        xfer.SetUrl(cfg.imageUrl)
        started = xfer.AsyncGetToFile(cfg.path)
    else
        xfer.SetUrl(cfg.url + "/api/stream?view=" + xfer.Escape(cfg.view) + "&output=roku")
        started = xfer.AsyncGetToString()
    end if
    if not started then
        m.top.result = { id: cfg.id, error: "Couldn't start the request.", offline: true }
        return
    end if

    msg = wait(30000, port)
    if msg = invalid then
        xfer.AsyncCancel()
        m.top.result = { id: cfg.id, error: "The hub didn't answer.", offline: true }
        return
    end if
    code = msg.GetResponseCode()

    if download then
        if code = 200 then
            m.top.result = { id: cfg.id, path: cfg.path, url: cfg.imageUrl, offline: false }
        else
            DeleteFile(cfg.path)
            m.top.result = { id: cfg.id, error: "Image download failed (" + code.ToStr() + ").", offline: false }
        end if
        return
    end if

    body = msg.GetString()
    data = invalid
    if Left(body, 1) = "{" then data = ParseJson(body)

    if code = 200 and data <> invalid and data.cards <> invalid then
        m.top.result = { stream: data, offline: false }
    else if code = 401 or code = 403 or Instr(1, body, "cloudflareaccess") > 0 then
        m.top.result = { error: "The hub didn't accept this channel's service token.", offline: false }
    else if code = 404 or (code = 200 and data = invalid) then
        ' An older hub: no route (404), or its page served in place of the API (200, HTML).
        m.top.result = { error: "This hub has no /api/stream. Upgrade its cc-family-hub to v0.9.0 or later.", offline: false }
    else if code < 0 then
        m.top.result = { error: "Network error: " + msg.GetFailureReason(), offline: true }
    else if data <> invalid and data.error <> invalid then
        ' e.g. 400 Unknown view "…". A 5xx is the hub having trouble: keep the last stream.
        m.top.result = { error: data.error, offline: code >= 500 }
    else
        m.top.result = { error: "The hub answered " + code.ToStr() + ".", offline: code >= 500 }
    end if
end sub

function makeTransfer(cfg as object) as object
    xfer = CreateObject("roUrlTransfer")
    xfer.SetCertificatesFile("common:/certs/ca-bundle.crt")
    xfer.InitClientCertificates()
    xfer.RetainBodyOnError(true)
    if cfg.clientId <> invalid and cfg.clientId <> "" then
        xfer.AddHeader("CF-Access-Client-Id", cfg.clientId)
        xfer.AddHeader("CF-Access-Client-Secret", cfg.clientSecret)
    end if
    return xfer
end function
