' Requests to the hub, off the render thread. config.mode:
'   "widget"   GET /api/widget?view=…           → result { data } or { error }
'   "photos"   GET /api/widget/photos            → result { photos } or { error }
'   "download" GET /api/widget/photos/<id> to config.path → result { path, id } or { error }

sub init()
    m.top.functionName = "doRequest"
end sub

sub doRequest()
    cfg = m.top.config
    mode = cfg.mode
    if mode = invalid or mode = "" then mode = "widget"

    xfer = makeTransfer(cfg)
    port = CreateObject("roMessagePort")
    xfer.SetMessagePort(port)

    if mode = "download" then
        xfer.SetUrl(cfg.url + "/api/widget/photos/" + xfer.Escape(cfg.id))
        started = xfer.AsyncGetToFile(cfg.path)
    else if mode = "photos" then
        xfer.SetUrl(cfg.url + "/api/widget/photos")
        started = xfer.AsyncGetToString()
    else
        xfer.SetUrl(cfg.url + "/api/widget?view=" + xfer.Escape(cfg.view))
        started = xfer.AsyncGetToString()
    end if
    if not started then
        m.top.result = { error: "Couldn't start the request." }
        return
    end if

    msg = wait(30000, port)
    if msg = invalid then
        xfer.AsyncCancel()
        m.top.result = { error: "The hub didn't answer." }
        return
    end if
    code = msg.GetResponseCode()

    if mode = "download" then
        if code = 200 then
            m.top.result = { path: cfg.path, id: cfg.id }
        else
            m.top.result = { error: "Photo download failed (" + code.ToStr() + ")." }
        end if
        return
    end if

    body = msg.GetString()
    data = invalid
    if Left(body, 1) = "{" then data = ParseJson(body)

    if code = 200 and data <> invalid and mode = "photos" and data.photos <> invalid then
        m.top.result = { photos: data.photos }
    else if code = 200 and data <> invalid and mode = "widget" and data.events <> invalid then
        m.top.result = { data: data }
    else if data <> invalid and data.error <> invalid then
        m.top.result = { error: data.error }
    else if code = 401 or code = 403 or Instr(1, body, "cloudflareaccess") > 0 then
        m.top.result = { error: "The hub didn't accept this channel's service token." }
    else if code = 404 then
        m.top.result = { error: "This hub doesn't have that yet. Upgrade its cc-family-hub version." }
    else if code < 0 then
        m.top.result = { error: "Network error: " + msg.GetFailureReason() }
    else
        m.top.result = { error: "The hub answered " + code.ToStr() + "." }
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
