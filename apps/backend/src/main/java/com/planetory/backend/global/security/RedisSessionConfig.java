package com.planetory.backend.global.security;

import java.time.Duration;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;
import org.springframework.core.env.Environment;
import org.springframework.data.redis.connection.RedisStandaloneConfiguration;
import org.springframework.data.redis.connection.lettuce.LettuceClientConfiguration;
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory;
import org.springframework.data.redis.core.RedisTemplate;
import org.springframework.data.redis.serializer.JdkSerializationRedisSerializer;
import org.springframework.data.redis.serializer.StringRedisSerializer;
import org.springframework.session.config.annotation.web.http.EnableSpringHttpSession;
import org.springframework.session.data.redis.RedisSessionRepository;
import org.springframework.session.web.http.DefaultCookieSerializer;
import org.springframework.session.web.http.SessionRepositoryFilter;

@Configuration(proxyBeanMethods = false)
@ConditionalOnWebApplication(type = ConditionalOnWebApplication.Type.SERVLET)
@ConditionalOnProperty(name = "planetory.session.redis.enabled", havingValue = "true", matchIfMissing = true)
@EnableSpringHttpSession
public class RedisSessionConfig {
    @Bean LettuceConnectionFactory sessionRedisConnectionFactory(Environment env) {
        return connection(env, "session");
    }
    @Bean @Primary LettuceConnectionFactory redisConnectionFactory(Environment env) {
        if (env.getRequiredProperty("planetory.redis.session.host").equals(env.getRequiredProperty("planetory.redis.cache.host"))
                && env.getRequiredProperty("planetory.redis.session.port").equals(env.getRequiredProperty("planetory.redis.cache.port"))) {
            throw new IllegalArgumentException("Session and cache Redis must use separate instances");
        }
        return connection(env, "cache");
    }
    private LettuceConnectionFactory connection(Environment env, String purpose) {
        String prefix = "planetory.redis." + purpose + ".";
        var server = new RedisStandaloneConfiguration(env.getRequiredProperty(prefix + "host"),
                env.getRequiredProperty(prefix + "port", Integer.class));
        String password = env.getProperty(prefix + "password");
        if (password != null && !password.isBlank()) server.setPassword(password);
        var options = io.lettuce.core.ClientOptions.builder().socketOptions(io.lettuce.core.SocketOptions.builder()
                .connectTimeout(Duration.ofSeconds(2)).build()).build();
        var client = LettuceClientConfiguration.builder().clientOptions(options).commandTimeout(Duration.ofSeconds(2))
                .shutdownTimeout(Duration.ZERO).build();
        return new LettuceConnectionFactory(server, client);
    }
    @Bean RedisSessions<?> sessionRepository(
            @Qualifier("sessionRedisConnectionFactory") LettuceConnectionFactory connection,
            org.springframework.boot.web.server.autoconfigure.ServerProperties server) {
        var template = new RedisTemplate<String, Object>();
        template.setConnectionFactory(connection);
        template.setKeySerializer(new StringRedisSerializer());
        template.setHashKeySerializer(new StringRedisSerializer());
        template.setDefaultSerializer(new JdkSerializationRedisSerializer());
        template.afterPropertiesSet();
        var repository = new RedisSessionRepository(template);
        repository.setRedisKeyNamespace("planetory:session");
        repository.setDefaultMaxInactiveInterval(server.getServlet().getSession().getTimeout());
        repository.setFlushMode(org.springframework.session.FlushMode.ON_SAVE);
        repository.setSaveMode(org.springframework.session.SaveMode.ON_SET_ATTRIBUTE);
        return new RedisSessions<>(repository, template);
    }
    @Bean org.springframework.boot.data.redis.health.DataRedisHealthIndicator redisHealthIndicator(
            @Qualifier("sessionRedisConnectionFactory") LettuceConnectionFactory connection) {
        // 캐시는 선택 의존성이므로 앱 전체 health는 인증 저장소만 검사한다.
        return new org.springframework.boot.data.redis.health.DataRedisHealthIndicator(connection);
    }
    @Bean DefaultCookieSerializer cookieSerializer(org.springframework.boot.web.server.autoconfigure.ServerProperties server) {
        var cookie = new DefaultCookieSerializer();
        var configured = server.getServlet().getSession().getCookie();
        cookie.setCookieName(configured.getName());
        cookie.setCookiePath(configured.getPath());
        cookie.setUseHttpOnlyCookie(Boolean.TRUE.equals(configured.getHttpOnly()));
        cookie.setUseSecureCookie(Boolean.TRUE.equals(configured.getSecure()));
        cookie.setSameSite(configured.getSameSite().attributeValue());
        return cookie;
    }
    @Bean FilterRegistrationBean<SessionDependencyFilter> sessionDependencyFilter(SecurityErrorWriter errors) {
        var registration = new FilterRegistrationBean<>(new SessionDependencyFilter(errors));
        registration.setOrder(SessionRepositoryFilter.DEFAULT_ORDER - 1);
        return registration;
    }
}
