' The hub on a TV. Fetches /api/stream?output=roku every 5 minutes (via FetchTask)
' and rotates through its cards in order, each for its dwell, with crossfades.
' The Worker composes the stream (docs/stream.md), photos between cards included,
' so this file only lays cards out:
'   today                 the hub screen: clock, next trip, today and tomorrow
'   photos                an album photo with a strip: clock, next event, trip countdown
'   trips, past-trips     the trip screen
'   grocery               the shopping list
'   pet-portraits         a pet over its photo, with its name and what's next
'   anything else         the card's glance: headline, detail, colors, image
' Left/right on the remote switch the view (family, then each member).

sub init()
    m.TEXT = "0xf3f5f7FF"
    m.MUTED = "0xf3f5f78C"
    m.ACCENT = "0x7dd3fcFF"
    m.URGENT = "0xf87171FF"
    m.MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    m.DEFAULT_DWELL = 10
    m.RETRY_SECONDS = 60

    m.layout = m.top.findNode("layout")
    m.viewLabel = m.top.findNode("viewLabel")
    m.clock = m.top.findNode("clock")
    m.date = m.top.findNode("date")
    m.events = m.top.findNode("events")
    m.message = m.top.findNode("message")
    m.status = m.top.findNode("status")
    m.hint = m.top.findNode("hint")
    m.trip = m.top.findNode("trip")
    m.offlineLabel = m.top.findNode("offline")
    m.photoLayer = m.top.findNode("photoLayer")
    m.tripLayer = m.top.findNode("tripLayer")
    m.groceryLayer = m.top.findNode("groceryLayer")
    m.glanceLayer = m.top.findNode("glanceLayer")
    m.petLayer = m.top.findNode("petLayer")
    m.frontPoster = m.top.findNode("photoA")
    m.backPoster = m.top.findNode("photoB")
    m.layers = { hub: m.layout, photo: m.photoLayer, trip: m.tripLayer, grocery: m.groceryLayer, glance: m.glanceLayer, pet: m.petLayer }
    m.top.findNode("swap").observeField("state", "onSwapState")
    m.top.findNode("dipOut").observeField("state", "onDipOut")

    m.config = loadConfig()
    m.registry = CreateObject("roRegistrySection", "family-hub")
    m.view = m.registry.Read("view")
    if m.view = "" then m.view = m.config.view
    if m.view = "" then m.view = "family"

    m.stream = invalid       ' the last stream the hub returned
    m.members = []           ' kept through errors, so left/right still works
    m.cards = []
    m.error = ""
    m.offline = false
    m.index = -1             ' the card showing (or being prepared)
    m.current = invalid      ' the card on screen
    m.showing = "hub"        ' the layer on screen: hub | photo | trip | grocery | glance | pet
    m.anchorId = ""          ' the last card shown that wasn't a photo
    m.sinceAnchor = 0        ' photos shown since it
    m.restart = true         ' show the first card as soon as the next stream arrives
    m.images = {}            ' card id → downloaded image (tmp:/)
    m.imageUrls = {}         ' card id → the URL it was downloaded from
    m.failed = {}            ' card id → true: its image didn't download this stream
    m.downloads = {}         ' card id → FetchTask
    m.pendingId = ""         ' card waiting for its image before it can show
    m.skipped = 0
    m.dipCard = invalid
    m.fileCounter = 0
    m.ticks = 0

    m.clockTimer = makeTimer(5, "onClock", true)
    m.refreshTimer = makeTimer(300, "refresh", true)
    m.dwellTimer = makeTimer(m.DEFAULT_DWELL, "onDwell", false)
    m.retryTimer = makeTimer(m.RETRY_SECONDS, "refresh", false)
    m.clockTimer.control = "start"
    m.refreshTimer.control = "start"
    onClock()
    showViewName()

    if m.config.url = "" then
        m.message.text = "No hub is set up. Rebuild the channel with HUB_URL in roku.env (see app/roku/README.md)."
    else
        m.message.text = "Loading…"
        refresh()
    end if
    m.top.setFocus(true)
end sub

function loadConfig() as object
    cfg = invalid
    text = ReadAsciiFile("pkg:/config.json")
    if text <> "" then cfg = ParseJson(text)
    if cfg = invalid then cfg = {}
    for each key in ["url", "clientId", "clientSecret", "view"]
        if cfg[key] = invalid then cfg[key] = ""
    end for
    return cfg
end function

function makeTimer(seconds as integer, handler as string, repeating as boolean) as object
    t = CreateObject("roSGNode", "Timer")
    t.duration = seconds
    t.repeat = repeating
    t.observeField("fire", handler)
    return t
end function

sub onModeChange()
    m.hint.visible = not m.top.screensaver
end sub

' ─── Data ────────────────────────────────────────────────────────────────────

sub refresh()
    if m.config.url = "" then return
    m.retryTimer.control = "stop"
    task = CreateObject("roSGNode", "FetchTask")
    task.config = { mode: "stream", url: m.config.url, view: m.view, clientId: m.config.clientId, clientSecret: m.config.clientSecret }
    task.observeField("result", "onStream")
    task.control = "RUN"
    m.task = task
end sub

sub onStream(event as object)
    ' Only the latest request counts (left/right can start one before the last returns).
    if not event.getRoSGNode().isSameNode(m.task) then return
    result = event.getData()
    if result.stream <> invalid then
        m.stream = result.stream
        m.members = m.stream.members
        if m.members = invalid then m.members = []
        m.error = ""
        m.offline = false
        m.failed = {}
        useCards(m.stream.cards)
    else if result.offline and m.stream <> invalid then
        ' Keep rotating the last stream, and try again soon.
        m.error = result.error
        m.offline = true
        m.retryTimer.control = "start"
    else
        showError(result.error)
        if result.offline then m.retryTimer.control = "start"
    end if
    showViewName()
    showStatus()
end sub

' Takes a new stream's cards, carrying on from the card showing now when it's still there.
sub useCards(cards as object)
    m.cards = cards
    pruneImages()
    n = cards.count()
    if n = 0 then
        showMessage("Nothing to show for this view yet.")
        return
    end if
    if m.restart or m.current = invalid then
        m.restart = false
        m.index = -1
        m.pendingId = ""
        m.dwellTimer.control = "stop"
        advance()
        return
    end if
    ' Find the card on screen in the new list. Photos are reshuffled on every
    ' request, so a photo's place is counted from the card before it.
    shownAt = m.index
    if m.pendingId <> "" then shownAt = m.index - 1
    here = -1
    anchor = -1
    for i = 0 to n - 1
        if cards[i].id = m.current.id then here = i
        if cards[i].id = m.anchorId then anchor = i
    end for
    if m.current.component = "photos" then here = -1
    if here < 0 and anchor >= 0 then here = anchor + m.sinceAnchor
    if here < 0 then here = shownAt
    if here >= n then here = n - 1
    m.index = here
    if m.pendingId <> "" then
        ' It was waiting on the next card's image: go on to the new list's next card.
        m.pendingId = ""
        advance()
        return
    end if
    ' The today screen carries the status line and the trip countdown: redraw it in place.
    if m.showing = "hub" and m.current.component = "today" then
        m.current = findCard(m.current.id, m.current)
        renderToday(m.current)
    end if
end sub

' Deletes downloaded photos the new stream no longer has, so tmp:/ doesn't fill up.
' A card whose image changed (a pet's next photo) keeps its id, so it's compared by URL.
sub pruneImages()
    keep = {}
    for each c in m.cards
        keep[c.id] = imageUrl(c)
    end for
    for each id in m.images.Keys()
        if keep[id] = invalid or keep[id] <> m.imageUrls[id] then
            if not isOnScreen(m.images[id]) then DeleteFile(m.images[id])
            m.images.Delete(id)
            m.imageUrls.Delete(id)
        end if
    end for
end sub

' Whether a downloaded file is what a poster is showing now (it's deleted when replaced).
function isOnScreen(path as string) as boolean
    for each id in ["petPhoto", "glanceImage", "tripHero"]
        if m.top.findNode(id).uri = path then return true
    end for
    return false
end function

sub showError(text as string)
    m.stream = invalid
    m.cards = []
    m.error = text
    showMessage(text)
    m.status.text = ""
end sub

' Stops the rotation and shows `text` on the today screen.
sub showMessage(text as string)
    m.current = invalid
    m.pendingId = ""
    m.restart = true
    m.dwellTimer.control = "stop"
    clearToday()
    m.message.text = text
    swapTo("hub")
end sub

function findCard(id as string, fallback as dynamic) as dynamic
    for each c in m.cards
        if c.id = id then return c
    end for
    return fallback
end function

function firstCard(component as string) as dynamic
    for each c in m.cards
        if c.component = component then return c
    end for
    return invalid
end function

' ─── Rotation ────────────────────────────────────────────────────────────────
' advance() moves to the next card. A card with an image (a photo, a trip's hero)
' waits for its download; the card after the one showing is downloaded while it shows.

sub onDwell()
    advance()
end sub

sub advance()
    n = m.cards.count()
    if n = 0 then return
    m.index = (m.index + 1) mod n
    card = m.cards[m.index]
    url = imageUrl(card)
    if url <> "" and m.images[card.id] = invalid and m.failed[card.id] = invalid then
        m.pendingId = card.id
        download(card)
        return
    end if
    if card.component = "photos" and m.images[card.id] = invalid then
        ' Its photo didn't download: skip it, unless nothing else can show.
        m.skipped = m.skipped + 1
        if m.skipped < n then advance()
        return
    end if
    showCard(card)
end sub

sub showCard(card as object)
    m.pendingId = ""
    m.skipped = 0
    if card.component = "photos" then
        showPhoto(card)
        return
    end if
    m.anchorId = card.id
    m.sinceAnchor = 0
    target = layerFor(card)
    if target = m.showing and m.current <> invalid and m.current.id <> card.id then
        dip(card)
    else
        renderCard(card)
        swapTo(target)
    end if
    m.current = card
    shown(card)
end sub

' After a card is on screen: time its dwell and fetch the next card's image.
sub shown(card as object)
    showStatus()
    dwell = card.dwell
    if dwell = invalid or dwell < 2 then dwell = m.DEFAULT_DWELL
    m.dwellTimer.control = "stop"
    m.dwellTimer.duration = dwell
    m.dwellTimer.control = "start"
    n = m.cards.count()
    if n > 1 then
        upcoming = m.cards[(m.index + 1) mod n]
        if imageUrl(upcoming) <> "" and m.images[upcoming.id] = invalid then download(upcoming)
    end if
end sub

function layerFor(card as object) as string
    c = card.component
    if c = "today" then return "hub"
    if c = "photos" then return "photo"
    if c = "trips" or c = "past-trips" then return "trip"
    if c = "grocery" then return "grocery"
    if c = "pet-portraits" or c = "house-portraits" then return "pet"
    return "glance"
end function

sub renderCard(card as object)
    c = card.component
    if c = "today" then
        renderToday(card)
    else if c = "trips" or c = "past-trips" then
        renderTripScreen(card)
    else if c = "grocery" then
        renderGrocery(card)
    else if c = "pet-portraits" or c = "house-portraits" then
        renderPortrait(card)
    else
        renderGlance(card)
    end if
end sub

function imageUrl(card as object) as string
    if card.glance = invalid or card.glance.image = invalid then return ""
    return card.glance.image
end function

function imagePath(card as object) as string
    p = m.images[card.id]
    if p = invalid then return ""
    return p
end function

sub download(card as object)
    if m.downloads[card.id] <> invalid then return
    m.fileCounter = m.fileCounter + 1
    task = CreateObject("roSGNode", "FetchTask")
    task.config = {
        mode: "download", id: card.id, imageUrl: imageUrl(card),
        path: "tmp:/card-" + m.fileCounter.ToStr() + ".jpg",
        clientId: m.config.clientId, clientSecret: m.config.clientSecret
    }
    task.observeField("result", "onDownloaded")
    task.control = "RUN"
    m.downloads[card.id] = task
end sub

sub onDownloaded(event as object)
    result = event.getData()
    id = result.id
    m.downloads.Delete(id)
    if result.path <> invalid then
        m.images[id] = result.path
        m.imageUrls[id] = result.url
    else
        m.failed[id] = true
    end if
    if id <> m.pendingId then return
    ' The rotation was waiting on this one: try the same card again.
    m.index = m.index - 1
    advance()
end sub

' Crossfades from the layer showing now to `target`.
sub swapTo(target as string)
    fromNode = m.layers[m.showing]
    toNode = m.layers[target]
    m.showing = target
    m.offlineLabel.visible = m.offline and target <> "hub"
    ' A dip in progress belongs to the layer being left.
    m.dipCard = invalid
    m.top.findNode("dipOut").control = "stop"
    m.top.findNode("dipIn").control = "stop"
    if fromNode.isSameNode(toNode) then
        toNode.visible = true
        toNode.opacity = 1
        return
    end if
    m.top.findNode("swap").control = "stop"
    for each key in m.layers
        layer = m.layers[key]
        if not layer.isSameNode(fromNode) and not layer.isSameNode(toNode) then
            layer.visible = false
            layer.opacity = 0
        end if
    end for
    toNode.opacity = 0
    toNode.visible = true
    m.top.findNode("swapIn").fieldToInterp = toNode.id + ".opacity"
    m.top.findNode("swapOut").fieldToInterp = fromNode.id + ".opacity"
    m.top.findNode("swap").control = "start"
end sub

sub onSwapState(event as object)
    if event.getData() <> "stopped" then return
    for each key in m.layers
        layer = m.layers[key]
        if key <> m.showing and layer.opacity = 0 then layer.visible = false
    end for
end sub

' The next card uses the layer already showing: fade it out, redraw, fade it in.
sub dip(card as object)
    m.dipCard = card
    layer = m.layers[m.showing]
    m.top.findNode("dipOutInterp").fieldToInterp = layer.id + ".opacity"
    m.top.findNode("dipInInterp").fieldToInterp = layer.id + ".opacity"
    m.top.findNode("dipOut").control = "start"
end sub

sub onDipOut(event as object)
    if event.getData() <> "stopped" or m.dipCard = invalid then return
    if layerFor(m.dipCard) <> m.showing then return
    renderCard(m.dipCard)
    m.dipCard = invalid
    m.top.findNode("dipIn").control = "start"
end sub

' ─── Remote ──────────────────────────────────────────────────────────────────

function onKeyEvent(key as string, press as boolean) as boolean
    if not press then return false
    if key = "left" or key = "right" then
        ids = ["family"]
        for each member in m.members
            ids.push(member.id)
        end for
        index = 0
        for i = 0 to ids.count() - 1
            if ids[i] = m.view then index = i
        end for
        if key = "right" then index = index + 1 else index = index - 1
        if index < 0 then index = ids.count() - 1
        if index >= ids.count() then index = 0
        m.view = ids[index]
        m.registry.Write("view", m.view)
        m.registry.Flush()
        m.restart = true
        showViewName()
        refresh()
        return true
    else if key = "OK" or key = "replay" then
        refresh()
        return true
    end if
    return false
end function

sub showViewName()
    m.viewLabel.text = "FAMILY"
    m.viewLabel.color = m.ACCENT
    if m.view = "family" then return
    m.viewLabel.text = UCase(m.view)
    for each member in m.members
        if member.id = m.view then
            m.viewLabel.text = UCase(member.name)
            m.viewLabel.color = toColor(member.color)
        end if
    end for
end sub

sub showStatus()
    if m.stream = invalid then
        m.status.text = ""
        m.offlineLabel.visible = false
        return
    end if
    status = "Updated " + isoTimeText(m.stream.generatedAt)
    if m.offline then status = "Offline since " + isoTimeText(m.stream.generatedAt) + " · " + m.error
    m.status.text = status
    m.offlineLabel.text = status
    m.offlineLabel.visible = m.offline and m.showing <> "hub"
end sub

' ─── Clock ───────────────────────────────────────────────────────────────────

sub onClock()
    now = CreateObject("roDateTime")
    now.ToLocalTime()
    m.clock.text = timeText(now)
    m.date.text = now.GetWeekday() + ", " + m.MONTHS[now.GetMonth() - 1] + " " + now.GetDayOfMonth().ToStr()
    m.top.findNode("photoClock").text = m.clock.text
    m.top.findNode("photoDate").text = m.date.text

    ' As a screensaver, drift a little each minute so nothing burns in.
    m.ticks = m.ticks + 1
    if m.top.screensaver and m.ticks mod 12 = 0 then
        offsets = [[0, 0], [-40, -30], [40, 20], [-30, 30], [30, -30], [0, 30]]
        o = offsets[(m.ticks \ 12) mod offsets.count()]
        m.layout.translation = o
        m.top.findNode("tripContent").translation = o
        m.top.findNode("groceryContent").translation = o
        m.top.findNode("glanceContent").translation = o
        m.top.findNode("petContent").translation = o
        m.top.findNode("photoStrip").translation = [o[0], 0]
    end if
end sub

function timeText(dt as object) as string
    h = dt.GetHours()
    minutes = dt.GetMinutes()
    suffix = " AM"
    if h >= 12 then suffix = " PM"
    h = h mod 12
    if h = 0 then h = 12
    mm = minutes.ToStr()
    if minutes < 10 then mm = "0" + mm
    return h.ToStr() + ":" + mm + suffix
end function

' ─── today ───────────────────────────────────────────────────────────────────

sub clearToday()
    m.events.removeChildrenIndex(m.events.getChildCount(), 0)
    m.trip.visible = false
end sub

sub renderToday(card as object)
    clearToday()
    d = card.data
    showViewName()
    m.message.text = ""
    events = d.events
    if events = invalid then events = []
    flags = d.flags
    if flags = invalid then flags = []

    y = 0
    for each f in flags
        if y >= 240 then exit for
        bar = CreateObject("roSGNode", "Rectangle")
        bar.width = 8
        bar.height = 52
        bar.translation = [0, y + 2]
        bar.color = m.URGENT
        m.events.appendChild(bar)
        addLabel(valueOr(f.message, ""), 32, y + 4, 36, true, m.URGENT, 948)
        y = y + 80
    end for
    if y > 0 then y = y + 20

    if events.count() = 0 then
        text = "Nothing else today or tomorrow"
        if d.eventsError <> invalid then text = "Calendars didn't load: " + d.eventsError
        addLabel(text, 0, y, 40, false, m.MUTED, 980)
    end if

    day = ""
    count = 0
    for each e in events
        hasPlace = e.location <> invalid and e.location <> ""
        rowHeight = 84
        if hasPlace then rowHeight = 122
        headHeight = 0
        if e.day <> day then
            headHeight = 64
            if day <> "" then headHeight = headHeight + 28
        end if
        if y + headHeight + rowHeight > 860 then exit for
        if e.day <> day then
            if day <> "" then y = y + 28
            addLabel(UCase(e.day), 0, y, 28, true, m.MUTED, 600)
            y = y + 64
            day = e.day
        end if
        addEvent(e, y, hasPlace)
        y = y + rowHeight
        count = count + 1
    end for
    more = events.count() - count
    if d.moreEvents <> invalid then more = more + d.moreEvents
    if more > 0 then addLabel("+" + more.ToStr() + " more", 36, y, 32, false, m.MUTED, 600)

    renderTripBox(firstCard("trips"))
end sub

sub addEvent(e as object, y as integer, hasPlace as boolean)
    barHeight = 60
    if hasPlace then barHeight = 98
    addColorBars(m.events, e.colors, 0, y + 2, barHeight)
    addLabel(e.time, 32, y + 8, 34, false, m.MUTED, 200)
    addLabel(e.title, 236, y, 46, true, m.TEXT, 744)
    if hasPlace then addLabel(e.location, 236, y + 58, 30, false, m.MUTED, 744)
end sub

' Member colors as a vertical bar, one segment per member (up to four).
sub addColorBars(parent as object, colors as dynamic, x as integer, y as integer, height as integer)
    if colors = invalid or colors.count() = 0 then colors = ["#888888"]
    n = colors.count()
    if n > 4 then n = 4
    segment = Int(height / n)
    for i = 0 to n - 1
        bar = CreateObject("roSGNode", "Rectangle")
        bar.width = 8
        bar.height = segment
        bar.translation = [x, y + i * segment]
        bar.color = toColor(colors[i])
        parent.appendChild(bar)
    end for
end sub

' The next trip, beside the clock: from the stream's first trips card.
sub renderTripBox(card as dynamic)
    if card = invalid then
        m.trip.visible = false
        return
    end if
    t = card.data
    m.trip.visible = true
    caption = m.top.findNode("tripCaption")
    number = m.top.findNode("tripNumber")
    if t.status = "active" then
        caption.text = "ON THE TRIP · DAY OF " + t.days.ToStr()
        number.text = t.day.ToStr()
    else
        caption.text = "DAYS TO GO"
        if t.daysUntil = 1 then caption.text = "DAY TO GO"
        number.text = t.daysUntil.ToStr()
    end if
    m.top.findNode("tripName").text = valueOr(t.name, card.title)
    m.top.findNode("tripDates").text = valueOr(t.dates, "")
end sub

function addLabel(text as string, x as integer, y as integer, size as integer, bold as boolean, color as string, width as integer) as object
    return addLabelTo(m.events, text, x, y, size, bold, color, width)
end function

function addLabelTo(parent as object, text as string, x as integer, y as integer, size as integer, bold as boolean, color as string, width as integer) as object
    font = CreateObject("roSGNode", "Font")
    font.uri = "font:SystemFontFile"
    if bold then font.uri = "font:BoldSystemFontFile"
    font.size = size
    label = CreateObject("roSGNode", "Label")
    label.font = font
    label.text = text
    label.color = color
    label.width = width
    label.translation = [x, y]
    parent.appendChild(label)
    return label
end function

sub clearChildren(node as object)
    node.removeChildrenIndex(node.getChildCount(), 0)
end sub

' ─── photos ──────────────────────────────────────────────────────────────────

sub showPhoto(card as object)
    path = m.images[card.id]
    m.images.Delete(card.id)   ' a photo is shown once; its file goes when the poster is reused
    renderPhotoStrip()
    old = m.backPoster.uri
    m.photoCard = card
    m.backPoster.unobserveField("loadStatus")
    m.backPoster.observeField("loadStatus", "onPosterLoaded")
    m.backPoster.uri = path
    if old <> "" and old <> path then DeleteFile(old)
end sub

' Fades the photo in once it's decoded.
sub onPosterLoaded()
    status = m.backPoster.loadStatus
    if status <> "ready" and status <> "failed" then return
    m.backPoster.unobserveField("loadStatus")
    if status = "failed" then
        advance()
        return
    end if

    if m.showing = "photo" then
        ' Photo to photo: crossfade the posters.
        m.top.findNode("fadeIn").fieldToInterp = m.backPoster.id + ".opacity"
        m.top.findNode("fadeOut").fieldToInterp = m.frontPoster.id + ".opacity"
        m.top.findNode("photoFade").control = "start"
    else
        m.backPoster.opacity = 1
        m.frontPoster.opacity = 0
        swapTo("photo")
    end if
    t = m.frontPoster
    m.frontPoster = m.backPoster
    m.backPoster = t
    m.sinceAnchor = m.sinceAnchor + 1
    m.current = m.photoCard
    shown(m.photoCard)
end sub

' The strip: the next event from the today card, the countdown from the first trip.
sub renderPhotoStrip()
    nextText = ""
    today = firstCard("today")
    if today <> invalid and today.data.events <> invalid then
        for each e in today.data.events
            if not e.allDay then
                prefix = ""
                if e.day <> "Today" then prefix = e.day + " "
                nextText = "Next: " + prefix + e.time + "   " + e.title
                exit for
            end if
        end for
    end if
    m.top.findNode("photoNext").text = nextText

    tripText = ""
    card = firstCard("trips")
    if card <> invalid then
        t = card.data
        name = valueOr(t.name, card.title)
        if t.status = "active" then
            tripText = name + " · day " + t.day.ToStr() + " of " + t.days.ToStr()
        else if t.daysUntil = 1 then
            tripText = name + " tomorrow"
        else
            tripText = name + " in " + t.daysUntil.ToStr() + " days"
        end if
    end if
    m.top.findNode("photoTrip").text = tripText
end sub

' ─── trips and past-trips ────────────────────────────────────────────────────

sub renderTripScreen(card as object)
    t = card.data
    past = card.component = "past-trips"
    m.top.findNode("tripHero").uri = imagePath(card)
    m.top.findNode("tripTitle").text = valueOr(t.name, card.title)
    place = valueOr(t.resort, "")
    if place = "" then place = valueOr(t.destination, "")
    m.top.findNode("tripResort").text = place
    m.top.findNode("tripRange").text = valueOr(t.dates, "")

    big = m.top.findNode("tripBig")
    label = m.top.findNode("tripBigLabel")
    today = m.top.findNode("tripToday")
    highlights = m.top.findNode("tripHighlights")
    clearChildren(today)
    clearChildren(highlights)
    big.text = ""
    label.text = ""

    if past then
        renderHighlights(highlights, t.highlights, valueOr(card.glance.detail, ""))
    else
        if t.status = "active" then
            big.text = "Day " + t.day.ToStr()
            label.text = "of " + t.days.ToStr()
        else
            big.text = t.daysUntil.ToStr()
            unit = "days"
            if t.daysUntil = 1 then unit = "day"
            label.text = unit + " " + valueOr(t.countdown, "to go")
        end if
        ' Today's plan, while the trip is on.
        if t.today <> invalid then
            y = 0
            for each item in t.today
                if y > 240 then exit for
                text = valueOr(item.title, "")
                if item.time <> invalid then text = item.time + "   " + text
                addLabelTo(today, text, 0, y, 34, false, m.TEXT, 960)
                y = y + 50
            end for
        end if
    end if

    renderBoard(t, past)
end sub

sub renderHighlights(parent as object, items as dynamic, fallback as string)
    if items = invalid or items.count() = 0 then
        addLabelTo(parent, fallback, 0, 0, 44, true, m.ACCENT, 960)
        return
    end if
    y = 0
    for each h in items
        if y > 480 then exit for
        addLabelTo(parent, valueOr(h.label, ""), 0, y, 44, true, m.TEXT, 960)
        caption = valueOr(h.caption, "")
        if caption <> "" then addLabelTo(parent, caption, 0, y + 54, 32, false, m.MUTED, 960)
        y = y + 110
    end for
end sub

sub renderBoard(t as object, past as boolean)
    heading = m.top.findNode("tripBoardTitle")
    board = m.top.findNode("tripBoard")
    clearChildren(board)
    heading.text = ""
    rows = t.leaderboard
    if rows = invalid then rows = []
    scored = false
    for each r in rows
        if r.points <> invalid and r.points > 0 then scored = true
    end for
    questsTotal = 0
    if t.questsTotal <> invalid then questsTotal = t.questsTotal
    if rows.count() = 0 or not (scored or questsTotal > 0) then return

    if past then title = "FINAL STANDINGS" else title = "LEADERBOARD"
    if questsTotal > 0 then title = title + "  ·  " + t.questsDone.ToStr() + " OF " + questsTotal.ToStr() + " QUESTS"
    heading.text = title
    count = 0
    for each r in rows
        if count >= 10 then exit for
        y = count * 76
        addLabelTo(board, (count + 1).ToStr(), 0, y + 6, 36, false, m.MUTED, 50)
        bar = CreateObject("roSGNode", "Rectangle")
        bar.width = 8
        bar.height = 52
        bar.translation = [60, y + 2]
        bar.color = toColor(valueOr(r.color, "#888888"))
        board.appendChild(bar)
        addLabelTo(board, valueOr(r.name, ""), 92, y, 44, false, m.TEXT, 440)
        points = 0
        if r.points <> invalid then points = r.points
        pts = addLabelTo(board, points.ToStr(), 540, y, 44, true, m.TEXT, 160)
        pts.horizAlign = "right"
        count = count + 1
    end for
    if rows.count() > count then
        addLabelTo(board, "+" + (rows.count() - count).ToStr() + " more", 92, count * 76 + 6, 32, false, m.MUTED, 600)
    end if
end sub

' ─── grocery ─────────────────────────────────────────────────────────────────
' Up to three columns of what's left to buy, each with the color of whoever added it.

sub renderGrocery(card as object)
    items = card.data.items
    if items = invalid then items = []
    toBuy = []
    for each item in items
        if not item.done then toBuy.push(item)
    end for
    m.top.findNode("groceryTitle").text = valueOr(card.title, "Grocery list")
    n = toBuy.count()
    count = n.ToStr() + " to buy"
    if n = 1 then count = "1 to buy"
    m.top.findNode("groceryCount").text = UCase(count)

    list = m.top.findNode("groceryItems")
    clearChildren(list)
    ROWS = 10
    COLUMNS = 3
    room = ROWS * COLUMNS
    if n > room then room = room - 1   ' leave the last place for "+N more"
    for i = 0 to n - 1
        if i >= room then exit for
        item = toBuy[i]
        x = (i \ ROWS) * 580
        y = (i mod ROWS) * 66
        dot = CreateObject("roSGNode", "Rectangle")
        dot.width = 16
        dot.height = 16
        dot.translation = [x, y + 20]
        dot.color = memberColor(item.addedBy, "0xf3f5f75A")
        list.appendChild(dot)
        text = valueOr(item.name, "")
        if item.quantity <> invalid and item.quantity > 1 then text = text + "  ×" + item.quantity.ToStr()
        addLabelTo(list, text, x + 36, y, 40, false, m.TEXT, 520)
    end for
    if n > room then
        x = (room \ ROWS) * 580
        y = (room mod ROWS) * 66
        addLabelTo(list, "+" + (n - room).ToStr() + " more", x + 36, y, 40, false, m.MUTED, 520)
    end if
end sub

function memberColor(id as dynamic, fallback as string) as string
    if id = invalid then return fallback
    for each member in m.members
        if member.id = id then return toColor(member.color)
    end for
    return fallback
end function

' ─── pet-portraits ───────────────────────────────────────────────────────────
' The pet's whole photo over a soft copy of it, and along the bottom its name, its
' age, and up to three things coming up (overdue ones in red). The emoji the other
' screens show are left out: the Roku's system font has none.

sub renderPortrait(card as object)
    d = card.data
    if d = invalid then d = {}
    ' A pet, or a house (house-portraits): the same layout.
    pet = d.pet
    if pet = invalid then pet = d.place
    if pet = invalid then pet = {}
    path = imagePath(card)
    photo = m.top.findNode("petPhoto")
    back = m.top.findNode("petBack")
    m.top.findNode("petDim").visible = path <> ""
    if photo.uri <> path then
        ' Hidden until it's loaded and sized (onPetPhoto).
        photo.opacity = 0
        back.opacity = 0
        photo.unobserveField("loadStatus")
        photo.observeField("loadStatus", "onPetPhoto")
        photo.uri = path
        back.uri = path
    end if

    nextList = m.top.findNode("petNext")
    clearChildren(nextList)
    items = d.next
    if items = invalid then items = []
    rows = 0
    for each n in items
        if rows >= 3 then exit for
        color = m.TEXT
        if n.overdue = true then color = m.URGENT
        rowText = valueOr(n.title, "") + "  ·  " + valueOr(n.when, "")
        if valueOr(n.note, "") <> "" then rowText = rowText + "  ·  " + n.note
        addLabelTo(nextList, rowText, 0, rows * 60, 40, n.overdue = true, color, 1700)
        rows = rows + 1
    end for

    ' Laid out from the bottom up, so a pet with nothing coming up sits as low as one with three.
    bottom = 1000
    nextTop = bottom - rows * 60
    nextList.translation = [106, nextTop]
    age = m.top.findNode("petAge")
    about = []
    if valueOr(pet.species, "") <> "" then about.push(pet.species)
    if valueOr(pet.age, "") <> "" then about.push(pet.age)
    if valueOr(pet.address, "") <> "" then about.push(pet.address)
    age.text = about.Join("  ·  ")
    ageTop = nextTop - 24
    if age.text <> "" then ageTop = nextTop - 70
    age.translation = [106, ageTop]
    name = m.top.findNode("petName")
    name.text = valueOr(pet.name, valueOr(card.glance.headline, ""))
    name.translation = [100, ageTop - 140]
end sub

' The photo at its own shape: whole and centered, over the soft copy covering the screen.
sub onPetPhoto()
    photo = m.top.findNode("petPhoto")
    status = photo.loadStatus
    if status <> "ready" and status <> "failed" then return
    photo.unobserveField("loadStatus")
    w = photo.bitmapWidth
    h = photo.bitmapHeight
    if status = "failed" or w <= 0 or h <= 0 then return
    fit = 1920 / w
    if 1080 / h < fit then fit = 1080 / h
    photo.width = Int(w * fit)
    photo.height = Int(h * fit)
    photo.translation = [Int((1920 - w * fit) / 2), Int((1080 - h * fit) / 2)]
    photo.opacity = 1
    cover = 1920 / w
    if 1080 / h > cover then cover = 1080 / h
    back = m.top.findNode("petBack")
    back.width = Int(w * cover)
    back.height = Int(h * cover)
    back.translation = [Int((1920 - w * cover) / 2), Int((1080 - h * cover) / 2)]
    back.opacity = 1
end sub

' ─── glance (every other component) ──────────────────────────────────────────

sub renderGlance(card as object)
    g = card.glance
    if g = invalid then g = {}
    path = imagePath(card)
    m.top.findNode("glanceImage").uri = path
    m.top.findNode("glanceDim").visible = path <> ""

    title = m.top.findNode("glanceTitle")
    title.text = UCase(valueOr(card.title, card.component))
    title.color = m.ACCENT
    if g.colors <> invalid and g.colors.count() > 0 then title.color = toColor(g.colors[0])

    headline = m.top.findNode("glanceHeadline")
    detail = m.top.findNode("glanceDetail")
    headline.text = valueOr(g.headline, valueOr(card.title, ""))
    detail.text = valueOr(g.detail, "")

    ' Headline and detail centered on the screen, with the card's member colors
    ' (or the accent) as a bar beside them. glance.emoji isn't drawn: the Roku's
    ' system font has no emoji, and shows them as empty boxes.
    headHeight = headline.boundingRect().height
    detailHeight = 0
    if detail.text <> "" then detailHeight = detail.boundingRect().height + 24
    y = Int((1080 - headHeight - detailHeight) / 2)
    if y < 180 then y = 180
    headline.translation = [136, y]
    detail.translation = [140, y + headHeight + 24]

    colors = m.top.findNode("glanceColors")
    clearChildren(colors)
    barColors = g.colors
    if barColors = invalid or barColors.count() = 0 then barColors = ["#7dd3fc"]
    addColorBars(colors, barColors, 100, y + 12, headHeight + detailHeight - 12)
end sub

' ─── Formatting ──────────────────────────────────────────────────────────────

function toColor(hex as dynamic) as string
    if hex = invalid or Len(hex) < 7 then return "0x888888FF"
    return "0x" + Mid(hex, 2, 6) + "FF"
end function

function valueOr(v as dynamic, fallback as string) as string
    if v = invalid then return fallback
    if type(v) <> "roString" and type(v) <> "String" then return fallback
    return v
end function

' "2026-11-18T21:56:12.123Z" → "3:56 PM" local
function isoTimeText(iso as dynamic) as string
    if iso = invalid then return ""
    base = iso
    dot = Instr(1, iso, ".")
    if dot > 0 then base = Left(iso, dot - 1) + "Z"
    dt = CreateObject("roDateTime")
    dt.FromISO8601String(base)
    dt.ToLocalTime()
    return timeText(dt)
end function
