package com.planetory.backend.domain.post.repository;

import com.planetory.backend.domain.post.entity.Post;
import jakarta.persistence.LockModeType;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;

public interface PostRepository extends JpaRepository<Post, Long> {
    /**
     * 잠금 대상은 글 한 행이다. 작성자를 join fetch 하면 PostgreSQL이 조인된 users 행까지 FOR UPDATE로 잠가
     * 발견 트랜잭션의 회원 행 잠금과 순서가 엇갈릴 수 있으므로 여기서는 조인하지 않는다.
     */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select p from Post p where p.id = :id")
    Optional<Post> findByIdForUpdate(long id);

    @Query("select p from Post p join fetch p.author where p.id = :id")
    Optional<Post> findWithAuthorById(long id);
}
