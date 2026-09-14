package com.planetory.backend.global.entity;

import jakarta.persistence.Column;
import jakarta.persistence.MappedSuperclass;
import java.time.Instant;
import lombok.Getter;
import org.hibernate.annotations.Generated;

/**
 * created_at 열을 가진 엔티티의 공통 부모. 값은 DB DEFAULT(CURRENT_TIMESTAMP)가 채우므로
 * 애플리케이션은 쓰지 않고 INSERT 후 읽기만 한다. updated_at은 갱신 시점을 서비스가 정하므로 각 엔티티가 직접 둔다.
 */
@Getter
@MappedSuperclass
public abstract class BaseTimeEntity {

    @Generated
    @Column(name = "created_at", nullable = false, insertable = false, updatable = false)
    private Instant createdAt;
}
