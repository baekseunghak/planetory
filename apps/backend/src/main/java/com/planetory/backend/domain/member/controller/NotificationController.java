package com.planetory.backend.domain.member.controller;

import com.planetory.backend.domain.member.service.NotificationService;
import com.planetory.backend.domain.post.service.CommunityQuery;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import com.planetory.backend.global.security.MemberPrincipal;
import java.util.Map;
import java.util.Set;
import java.util.function.Supplier;
import lombok.RequiredArgsConstructor;
import org.springframework.dao.DataAccessException;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.util.MultiValueMap;
import org.springframework.web.bind.annotation.*;

@RestController
@RequiredArgsConstructor
public class NotificationController {
    private final NotificationService notifications;

    @GetMapping("/api/v1/me/notification-settings")
    public ResponseEntity<?> settings(@AuthenticationPrincipal MemberPrincipal member,
            @RequestParam MultiValueMap<String,String> params) {
        CommunityQuery.only(params,Set.of());
        return response(()->notifications.preferences(member.memberId()));
    }
    @PatchMapping("/api/v1/me/notification-settings")
    public ResponseEntity<?> settings(@AuthenticationPrincipal MemberPrincipal member,
            @RequestBody Map<String,Object> body,@RequestParam MultiValueMap<String,String> params) {
        CommunityQuery.only(params,Set.of());
        return response(()->notifications.changePreferences(member.memberId(),body));
    }
    @GetMapping("/api/v1/me/notifications")
    public ResponseEntity<?> list(@AuthenticationPrincipal MemberPrincipal member,
            @RequestParam MultiValueMap<String,String> params) {
        CommunityQuery.only(params,Set.of("size","cursor","unreadOnly"));
        int size=20;
        if (params.containsKey("size")) {
            try { size=Integer.parseInt(params.getFirst("size")); }
            catch (NumberFormatException e) { throw invalid(); }
            if (size<1 || size>100) throw invalid();
        }
        String unread=params.containsKey("unreadOnly")?params.getFirst("unreadOnly"):"false";
        if (!Set.of("true","false").contains(unread)) throw invalid();
        final int pageSize=size;
        return response(()->notifications.list(member.memberId(),pageSize,unread.equals("true"),params.getFirst("cursor")));
    }
    @GetMapping("/api/v1/me/notifications/unread-count")
    public ResponseEntity<?> count(@AuthenticationPrincipal MemberPrincipal member,
            @RequestParam MultiValueMap<String,String> params) {
        CommunityQuery.only(params,Set.of());
        return response(()->notifications.count(member.memberId()));
    }
    @GetMapping("/api/v1/me/notifications/{id}/target")
    public ResponseEntity<?> target(@AuthenticationPrincipal MemberPrincipal member,@PathVariable String id,
            @RequestParam MultiValueMap<String,String> params) {
        CommunityQuery.only(params,Set.of());
        long notification=CommunityQuery.id(id,"n-");
        return response(()->notifications.target(member.memberId(),notification));
    }
    @PatchMapping("/api/v1/me/notifications/read")
    public ResponseEntity<?> readAll(@AuthenticationPrincipal MemberPrincipal member,@RequestBody Map<String,Object> body,
            @RequestParam MultiValueMap<String,String> params) {
        CommunityQuery.only(params,Set.of());
        if (body==null || !body.keySet().equals(Set.of("through")) || !(body.get("through") instanceof String through)) throw invalid();
        return response(()->notifications.readThrough(member.memberId(),through));
    }
    @PatchMapping("/api/v1/me/notifications/{id}")
    public ResponseEntity<?> read(@AuthenticationPrincipal MemberPrincipal member,@PathVariable String id,
            @RequestBody Map<String,Object> body,@RequestParam MultiValueMap<String,String> params) {
        CommunityQuery.only(params,Set.of());
        if (body==null || !body.keySet().equals(Set.of("read")) || !Boolean.TRUE.equals(body.get("read"))) throw invalid();
        long notification=CommunityQuery.id(id,"n-");
        return response(()->notifications.read(member.memberId(),notification));
    }
    private static ResponseEntity<?> response(Supplier<?> action) {
        try { return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(action.get()); }
        catch (DataAccessException e) { throw new BusinessException(ErrorCode.DEPENDENCY_UNAVAILABLE); }
    }
    private static BusinessException invalid() { return new BusinessException(ErrorCode.VALIDATION_FAILED); }
}
