package com.planetory.backend.domain.auth.dto;

public record CsrfResponse(String headerName, String token) {}
